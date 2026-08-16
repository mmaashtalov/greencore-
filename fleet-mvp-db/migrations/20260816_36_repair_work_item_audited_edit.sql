create table if not exists private.repair_work_item_changes(
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.repair_work_items(id) on delete restrict,
  repair_case_id uuid not null references public.repair_cases(id) on delete restrict,
  changed_at timestamptz not null default now(),
  changed_by uuid references public.profiles(id) on delete set null,
  reason text not null,
  before_data jsonb not null,
  after_data jsonb not null
);
revoke all on table private.repair_work_item_changes from public,anon,authenticated;

alter table public.repair_work_items add column if not exists updated_at timestamptz;
alter table public.repair_work_items add column if not exists updated_by uuid references public.profiles(id) on delete set null;

create or replace function public.update_repair_work_item(
  p_item_id uuid,
  p_description text,
  p_part_name text,
  p_quantity numeric,
  p_cost_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  w public.repair_work_items%rowtype;
  r public.repair_cases%rowtype;
  v_part text;
  v_qty numeric;
  v_reason text;
  v_before jsonb;
  v_after jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into w from public.repair_work_items where id=p_item_id for update;
  if w.id is null then raise exception 'Repair work item not found'; end if;
  select * into r from public.repair_cases where id=w.repair_case_id for update;
  if r.id is null then raise exception 'Repair case not found'; end if;
  if r.status not in ('in_repair','testing') then raise exception 'Repair work item is frozen after repair completion'; end if;
  if nullif(btrim(p_description),'') is null then raise exception 'Work description is required'; end if;
  v_reason:=nullif(btrim(p_reason),'');
  if v_reason is null or char_length(v_reason)<5 then raise exception 'Correction reason must contain at least 5 characters'; end if;
  v_part:=nullif(btrim(p_part_name),'');
  if p_quantity is not null and p_quantity<=0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_cost_amount is not null and p_cost_amount<0 then raise exception 'Cost cannot be negative'; end if;
  if v_part is null and p_quantity is not null then raise exception 'Part name is required when quantity is specified'; end if;
  v_qty:=case when v_part is null then null else coalesce(p_quantity,1) end;

  v_before:=jsonb_build_object(
    'description',w.description,'part_name',w.part_name,'quantity',w.quantity,
    'cost_amount',w.cost_amount,'completed_at',w.completed_at
  );
  v_after:=jsonb_build_object(
    'description',btrim(p_description),'part_name',v_part,'quantity',v_qty,
    'cost_amount',p_cost_amount,'completed_at',w.completed_at
  );
  if v_before=v_after then raise exception 'No changes to save'; end if;

  update public.repair_work_items
     set description=btrim(p_description),part_name=v_part,quantity=v_qty,cost_amount=p_cost_amount,
         updated_at=now(),updated_by=auth.uid()
   where id=w.id;

  insert into private.repair_work_item_changes(work_item_id,repair_case_id,changed_by,reason,before_data,after_data)
  values(w.id,w.repair_case_id,auth.uid(),v_reason,v_before,v_after);

  return jsonb_build_object('id',w.id,'changed',true,'updated_at',now());
end
$function$;

create or replace function public.get_repair_work_items_ui(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare r public.repair_cases%rowtype;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.repair_cases where id=p_case_id;
  if r.id is null then raise exception 'Repair case not found'; end if;
  return jsonb_build_object(
    'ui_version','repair_work_items_v2',
    'case_id',r.id,
    'repair_status',r.status,
    'can_add',r.status='in_repair',
    'can_edit',r.status in ('in_repair','testing'),
    'frozen',r.status in ('closed','cancelled'),
    'summary',jsonb_build_object(
      'completed_count',(select count(*)::int from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null),
      'total_cost',(select coalesce(sum(w.cost_amount),0) from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null)
    ),
    'items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',w.id,'description',w.description,'part_name',w.part_name,'quantity',w.quantity,
        'cost_amount',w.cost_amount,'completed_at',w.completed_at,'recorded_by',w.recorded_by,
        'updated_at',w.updated_at,'updated_by',w.updated_by,
        'change_count',(select count(*)::int from private.repair_work_item_changes c where c.work_item_id=w.id),
        'can_edit',r.status in ('in_repair','testing')
      ) order by w.completed_at,w.created_at)
      from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null
    ),'[]'::jsonb)
  );
end
$function$;

revoke all on function public.update_repair_work_item(uuid,text,text,numeric,numeric,text) from public,anon;
grant execute on function public.update_repair_work_item(uuid,text,text,numeric,numeric,text) to authenticated;
revoke all on function public.get_repair_work_items_ui(uuid) from public,anon;
grant execute on function public.get_repair_work_items_ui(uuid) to authenticated;
