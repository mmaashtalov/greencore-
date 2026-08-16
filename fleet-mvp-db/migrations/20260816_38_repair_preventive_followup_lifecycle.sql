create table if not exists private.repair_preventive_followups(
  id uuid primary key default gen_random_uuid(),
  repair_case_id uuid not null unique references public.repair_cases(id) on delete restrict,
  vehicle_id uuid not null references public.vehicles(id) on delete restrict,
  action_text text not null,
  status text not null default 'open' check(status in ('open','completed','cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references public.profiles(id) on delete set null,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete set null,
  cancel_reason text
);
revoke all on table private.repair_preventive_followups from public,anon,authenticated;
create index if not exists repair_preventive_followups_open_idx on private.repair_preventive_followups(status,created_at) where status='open';
create index if not exists repair_preventive_followups_vehicle_idx on private.repair_preventive_followups(vehicle_id,status,created_at desc);

create or replace function private.capture_repair_preventive_followup()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
begin
  if new.status='closed' and old.status is distinct from 'closed'
     and new.preventability::text in ('preventable','partially_preventable')
     and nullif(btrim(new.preventive_action),'') is not null then
    insert into private.repair_preventive_followups(repair_case_id,vehicle_id,action_text,created_by)
    values(new.id,new.vehicle_id,btrim(new.preventive_action),auth.uid())
    on conflict(repair_case_id) do nothing;
  end if;
  return new;
end
$function$;

drop trigger if exists repair_preventive_followup_on_close on public.repair_cases;
create trigger repair_preventive_followup_on_close
after update of status on public.repair_cases
for each row
when (new.status='closed' and old.status is distinct from 'closed')
execute function private.capture_repair_preventive_followup();

create or replace function public.get_repair_preventive_followups_ui()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  return jsonb_build_object(
    'ui_version','repair_preventive_followups_v1',
    'open_count',(select count(*)::int from private.repair_preventive_followups f where f.status='open'),
    'items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',f.id,'repair_case_id',f.repair_case_id,'vehicle_id',f.vehicle_id,
        'vehicle_label',concat_ws(' ',v.make,v.model)||' №'||coalesce(v.internal_number,v.registration_number),
        'action_text',f.action_text,'created_at',f.created_at,
        'diagnosis',r.diagnosis,'root_cause',r.root_cause,'preventability',r.preventability,
        'repair_closed_at',r.closed_at
      ) order by f.created_at)
      from private.repair_preventive_followups f
      join public.repair_cases r on r.id=f.repair_case_id
      join public.vehicles v on v.id=f.vehicle_id
      where f.status='open'
    ),'[]'::jsonb),
    'recent_history',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',x.id,'repair_case_id',x.repair_case_id,'vehicle_label',x.vehicle_label,
        'action_text',x.action_text,'status',x.status,'finished_at',x.finished_at,
        'cancel_reason',x.cancel_reason
      ) order by x.finished_at desc)
      from (
        select f.id,f.repair_case_id,concat_ws(' ',v.make,v.model)||' №'||coalesce(v.internal_number,v.registration_number) vehicle_label,
               f.action_text,f.status,coalesce(f.completed_at,f.cancelled_at) finished_at,f.cancel_reason
        from private.repair_preventive_followups f
        join public.vehicles v on v.id=f.vehicle_id
        where f.status<>'open'
        order by coalesce(f.completed_at,f.cancelled_at) desc nulls last
        limit 10
      ) x
    ),'[]'::jsonb)
  );
end
$function$;

create or replace function public.complete_repair_preventive_followup(p_followup_id uuid)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  update private.repair_preventive_followups
     set status='completed',completed_at=now(),completed_by=auth.uid(),cancelled_at=null,cancelled_by=null,cancel_reason=null
   where id=p_followup_id and status='open';
  if not found then raise exception 'Preventive follow-up not found or already closed'; end if;
end
$function$;

create or replace function public.cancel_repair_preventive_followup(p_followup_id uuid,p_reason text)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare v_reason text;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  v_reason:=nullif(btrim(p_reason),'');
  if v_reason is null or char_length(v_reason)<5 then raise exception 'Cancellation reason must contain at least 5 characters'; end if;
  update private.repair_preventive_followups
     set status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),cancel_reason=v_reason,completed_at=null,completed_by=null
   where id=p_followup_id and status='open';
  if not found then raise exception 'Preventive follow-up not found or already closed'; end if;
end
$function$;

revoke all on function public.get_repair_preventive_followups_ui() from public,anon;
grant execute on function public.get_repair_preventive_followups_ui() to authenticated;
revoke all on function public.complete_repair_preventive_followup(uuid) from public,anon;
grant execute on function public.complete_repair_preventive_followup(uuid) to authenticated;
revoke all on function public.cancel_repair_preventive_followup(uuid,text) from public,anon;
grant execute on function public.cancel_repair_preventive_followup(uuid,text) to authenticated;
