create or replace function public.get_historical_repair_work_correction_ui(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  r public.repair_cases%rowtype;
  v public.vehicles%rowtype;
  v_end timestamptz;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.repair_cases where id=p_case_id;
  if r.id is null then raise exception 'Repair case not found'; end if;
  if r.status::text not in ('closed','cancelled') then raise exception 'Historical correction is available only after repair completion'; end if;
  select * into v from public.vehicles where id=r.vehicle_id;
  if v.id is null then raise exception 'Vehicle not found'; end if;
  v_end:=coalesce(r.closed_at,now());

  return jsonb_build_object(
    'ui_version','historical_repair_work_correction_v1',
    'case_id',r.id,
    'repair_status',r.status,
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,''))),
    'window',jsonb_build_object('opened_at',r.opened_at,'closed_at',v_end),
    'summary',jsonb_build_object(
      'completed_count',(select count(*)::int from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null),
      'priced_count',(select count(*)::int from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null and w.cost_amount is not null),
      'unpriced_count',(select count(*)::int from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null and w.cost_amount is null),
      'recorded_cost',(select coalesce(sum(w.cost_amount) filter(where w.completed_at is not null and w.cost_amount is not null),0) from public.repair_work_items w where w.repair_case_id=r.id)
    ),
    'items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',w.id,
        'description',w.description,
        'part_name',w.part_name,
        'quantity',w.quantity,
        'cost_amount',w.cost_amount,
        'completed_at',w.completed_at,
        'recorded_by',w.recorded_by,
        'updated_at',w.updated_at,
        'updated_by',w.updated_by,
        'change_count',(select count(*)::int from private.repair_work_item_changes c where c.work_item_id=w.id)
      ) order by w.completed_at,w.created_at)
      from public.repair_work_items w
      where w.repair_case_id=r.id and w.completed_at is not null
    ),'[]'::jsonb),
    'form',jsonb_build_object(
      'reason_min_chars',5,
      'description_max_chars',500,
      'part_name_max_chars',160,
      'reason_max_chars',300
    ),
    'ux_rules',jsonb_build_object(
      'reason_required',true,
      'null_cost_means_unknown',true,
      'explicit_zero_cost_is_valid',true,
      'repair_state_is_immutable',true,
      'vehicle_state_is_immutable',true,
      'historical_time_must_be_inside_repair_window',true
    )
  );
end;
$function$;

create or replace function public.record_historical_repair_work_item(
  p_case_id uuid,
  p_description text,
  p_part_name text,
  p_quantity numeric,
  p_cost_amount numeric,
  p_completed_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  r public.repair_cases%rowtype;
  v_id uuid;
  v_part text;
  v_qty numeric;
  v_reason text;
  v_end timestamptz;
  v_after jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.repair_cases where id=p_case_id for update;
  if r.id is null then raise exception 'Repair case not found'; end if;
  if r.status::text not in ('closed','cancelled') then raise exception 'Historical work can be added only after repair completion'; end if;
  if nullif(btrim(p_description),'') is null then raise exception 'Work description is required'; end if;
  v_reason:=nullif(btrim(p_reason),'');
  if v_reason is null or char_length(v_reason)<5 then raise exception 'Correction reason must contain at least 5 characters'; end if;
  if char_length(v_reason)>300 then raise exception 'Correction reason is too long'; end if;
  if char_length(btrim(p_description))>500 then raise exception 'Work description is too long'; end if;
  v_part:=nullif(btrim(p_part_name),'');
  if v_part is not null and char_length(v_part)>160 then raise exception 'Part name is too long'; end if;
  if p_quantity is not null and p_quantity<=0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_cost_amount is not null and p_cost_amount<0 then raise exception 'Cost cannot be negative'; end if;
  if v_part is null and p_quantity is not null then raise exception 'Part name is required when quantity is specified'; end if;
  if p_completed_at is null then raise exception 'Historical completion time is required'; end if;
  v_end:=coalesce(r.closed_at,now());
  if p_completed_at<r.opened_at or p_completed_at>v_end then raise exception 'Historical work time must be inside the repair window'; end if;
  v_qty:=case when v_part is null then null else coalesce(p_quantity,1) end;

  insert into public.repair_work_items(repair_case_id,description,part_name,quantity,cost_amount,completed_at,recorded_by,updated_at,updated_by)
  values(r.id,btrim(p_description),v_part,v_qty,p_cost_amount,p_completed_at,auth.uid(),now(),auth.uid())
  returning id into v_id;

  v_after:=jsonb_build_object(
    'record_exists',true,
    'description',btrim(p_description),
    'part_name',v_part,
    'quantity',v_qty,
    'cost_amount',p_cost_amount,
    'completed_at',p_completed_at,
    'historical_backfill',true
  );
  insert into private.repair_work_item_changes(work_item_id,repair_case_id,changed_by,reason,before_data,after_data)
  values(v_id,r.id,auth.uid(),v_reason,jsonb_build_object('record_exists',false),v_after);

  return jsonb_build_object('id',v_id,'created',true,'historical_backfill',true,'updated_at',now());
end;
$function$;

create or replace function public.correct_historical_repair_work_item(
  p_item_id uuid,
  p_description text,
  p_part_name text,
  p_quantity numeric,
  p_cost_amount numeric,
  p_completed_at timestamptz,
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
  v_end timestamptz;
  v_before jsonb;
  v_after jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into w from public.repair_work_items where id=p_item_id for update;
  if w.id is null then raise exception 'Repair work item not found'; end if;
  select * into r from public.repair_cases where id=w.repair_case_id for update;
  if r.id is null then raise exception 'Repair case not found'; end if;
  if r.status::text not in ('closed','cancelled') then raise exception 'Historical correction is available only after repair completion'; end if;
  if nullif(btrim(p_description),'') is null then raise exception 'Work description is required'; end if;
  v_reason:=nullif(btrim(p_reason),'');
  if v_reason is null or char_length(v_reason)<5 then raise exception 'Correction reason must contain at least 5 characters'; end if;
  if char_length(v_reason)>300 then raise exception 'Correction reason is too long'; end if;
  if char_length(btrim(p_description))>500 then raise exception 'Work description is too long'; end if;
  v_part:=nullif(btrim(p_part_name),'');
  if v_part is not null and char_length(v_part)>160 then raise exception 'Part name is too long'; end if;
  if p_quantity is not null and p_quantity<=0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_cost_amount is not null and p_cost_amount<0 then raise exception 'Cost cannot be negative'; end if;
  if v_part is null and p_quantity is not null then raise exception 'Part name is required when quantity is specified'; end if;
  if p_completed_at is null then raise exception 'Historical completion time is required'; end if;
  v_end:=coalesce(r.closed_at,now());
  if p_completed_at<r.opened_at or p_completed_at>v_end then raise exception 'Historical work time must be inside the repair window'; end if;
  v_qty:=case when v_part is null then null else coalesce(p_quantity,1) end;

  v_before:=jsonb_build_object(
    'record_exists',true,
    'description',w.description,
    'part_name',w.part_name,
    'quantity',w.quantity,
    'cost_amount',w.cost_amount,
    'completed_at',w.completed_at
  );
  v_after:=jsonb_build_object(
    'record_exists',true,
    'description',btrim(p_description),
    'part_name',v_part,
    'quantity',v_qty,
    'cost_amount',p_cost_amount,
    'completed_at',p_completed_at
  );
  if v_before=v_after then raise exception 'No changes to save'; end if;

  update public.repair_work_items
     set description=btrim(p_description),part_name=v_part,quantity=v_qty,cost_amount=p_cost_amount,
         completed_at=p_completed_at,updated_at=now(),updated_by=auth.uid()
   where id=w.id;

  insert into private.repair_work_item_changes(work_item_id,repair_case_id,changed_by,reason,before_data,after_data)
  values(w.id,r.id,auth.uid(),v_reason,v_before,v_after);

  return jsonb_build_object('id',w.id,'changed',true,'historical_correction',true,'updated_at',now());
end;
$function$;

revoke all on function public.get_historical_repair_work_correction_ui(uuid) from public,anon;
grant execute on function public.get_historical_repair_work_correction_ui(uuid) to authenticated;
revoke all on function public.record_historical_repair_work_item(uuid,text,text,numeric,numeric,timestamptz,text) from public,anon;
grant execute on function public.record_historical_repair_work_item(uuid,text,text,numeric,numeric,timestamptz,text) to authenticated;
revoke all on function public.correct_historical_repair_work_item(uuid,text,text,numeric,numeric,timestamptz,text) from public,anon;
grant execute on function public.correct_historical_repair_work_item(uuid,text,text,numeric,numeric,timestamptz,text) to authenticated;
