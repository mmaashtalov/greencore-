create or replace function public.advance_repair_case(p_case_id uuid, p_action text)
returns void
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare
  r public.repair_cases%rowtype;
  v_profile uuid;
  v_completion_note constant text := 'Ремонт завершён. Техника возвращена в эксплуатацию.';
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.repair_cases where id=p_case_id for update;
  if r.id is null then raise exception 'Repair case not found'; end if;
  select id into v_profile from public.profiles where id=auth.uid();

  if p_action='start_diagnostics' and r.status='reported' then
    update public.repair_cases set status='diagnostics' where id=r.id;
    update public.vehicles set status='repair' where id=r.vehicle_id and status not in ('destroyed','written_off');
    if r.defect_id is not null then update public.vehicle_defects set status='in_repair' where id=r.defect_id; end if;
  elsif p_action='wait_parts' and r.status='diagnostics' then
    update public.repair_cases set status='waiting_parts' where id=r.id;
  elsif p_action='start_repair' and r.status in ('diagnostics','waiting_parts') then
    if nullif(btrim(r.diagnosis),'') is null then raise exception 'Diagnosis is required before repair'; end if;
    update public.repair_cases set status='in_repair' where id=r.id;
  elsif p_action='parts_received' and r.status='waiting_parts' then
    if nullif(btrim(r.diagnosis),'') is null then raise exception 'Diagnosis is required before repair'; end if;
    update public.repair_cases set status='in_repair' where id=r.id;
  elsif p_action='start_testing' and r.status='in_repair' then
    update public.repair_cases set status='testing' where id=r.id;
  elsif p_action='return_to_service' and r.status='testing' then
    if nullif(btrim(r.diagnosis),'') is null then raise exception 'Diagnosis is required before return to service'; end if;
    update public.repair_cases set status='closed',closed_at=now() where id=r.id;
    if r.defect_id is not null then update public.vehicle_defects set status='resolved' where id=r.defect_id; end if;
    update public.vehicles set status='operational' where id=r.vehicle_id and status='repair';

    update public.vehicle_incidents i
       set status='closed', resolved_at=coalesce(i.resolved_at,now()), resolved_by=coalesce(i.resolved_by,v_profile)
     where i.id in (
       select dp.incident_id from public.document_packages dp
        where dp.repair_case_id=r.id and dp.incident_id is not null
     )
       and i.outcome='repairable'
       and i.status<>'closed';

    insert into public.incident_updates(incident_id,update_type,body,author_profile_id)
    select distinct dp.incident_id,'status_note',v_completion_note,v_profile
      from public.document_packages dp
     where dp.repair_case_id=r.id and dp.incident_id is not null
       and not exists (
         select 1 from public.incident_updates u
          where u.incident_id=dp.incident_id and u.update_type='status_note' and u.body=v_completion_note
       );

    update public.notifications
       set is_read=true
     where employee_id is null
       and vehicle_id=r.vehicle_id
       and notification_type in ('repair','incident')
       and not is_read;
  else
    raise exception 'Action is not allowed for current repair stage';
  end if;
end
$function$;