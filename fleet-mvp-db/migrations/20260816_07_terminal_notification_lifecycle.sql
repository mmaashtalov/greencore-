-- Fleet MVP terminal notification lifecycle.
-- Applied to Supabase project: fleet-mvp (tikjmiyrhkcjrxjylmqb)
-- Resolved incidents and completed repairs should not remain as unread work.

create or replace function public.advance_repair_case(p_case_id uuid, p_action text)
returns void
language plpgsql
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  r public.repair_cases%rowtype;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.repair_cases where id=p_case_id for update;
  if r.id is null then raise exception 'Repair case not found'; end if;

  if p_action='start_diagnostics' and r.status='reported' then
    update public.repair_cases set status='diagnostics' where id=r.id;
    update public.vehicles set status='repair' where id=r.vehicle_id and status not in ('destroyed','written_off');
    if r.defect_id is not null then update public.vehicle_defects set status='in_repair' where id=r.defect_id; end if;
  elsif p_action='wait_parts' and r.status='diagnostics' then
    update public.repair_cases set status='waiting_parts' where id=r.id;
  elsif p_action='start_repair' and r.status in ('diagnostics','waiting_parts') then
    update public.repair_cases set status='in_repair' where id=r.id;
  elsif p_action='parts_received' and r.status='waiting_parts' then
    update public.repair_cases set status='in_repair' where id=r.id;
  elsif p_action='start_testing' and r.status='in_repair' then
    update public.repair_cases set status='testing' where id=r.id;
  elsif p_action='return_to_service' and r.status='testing' then
    if r.diagnosis is null or btrim(r.diagnosis)='' then raise exception 'Diagnosis is required before return to service'; end if;
    update public.repair_cases set status='closed',closed_at=now() where id=r.id;
    if r.defect_id is not null then update public.vehicle_defects set status='resolved' where id=r.defect_id; end if;
    update public.vehicles set status='operational' where id=r.vehicle_id and status='repair';
    update public.notifications
    set is_read=true
    where employee_id is null
      and vehicle_id=r.vehicle_id
      and notification_type='repair'
      and not is_read;
  else
    raise exception 'Action is not allowed for current repair stage';
  end if;
end;
$function$;

create or replace function private.set_incident_vehicle_condition_impl(
  p_incident_id uuid,
  p_outcome public.vehicle_outcome,
  p_note text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  inc public.vehicle_incidents%rowtype;
  v_profile uuid;
  v_new_status public.incident_status;
  v_vehicle_status public.vehicle_status;
  v_package_type text;
  v_repair_id uuid;
  v_message text;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  if p_outcome='unknown' then raise exception 'Choose a concrete vehicle condition'; end if;

  select * into inc from public.vehicle_incidents where id=p_incident_id for update;
  if inc.id is null then raise exception 'Incident not found'; end if;
  if inc.status='closed' and inc.outcome is distinct from p_outcome then raise exception 'Closed incident cannot be silently changed'; end if;
  select id into v_profile from public.profiles where id=auth.uid();

  case p_outcome
    when 'operational' then
      v_new_status := 'closed'; v_vehicle_status := 'operational'; v_package_type := 'INCIDENT_PACKAGE';
      v_message := 'Техника может продолжать эксплуатацию.';
    when 'damaged' then
      v_new_status := 'investigating'; v_vehicle_status := 'disabled'; v_package_type := 'INCIDENT_PACKAGE';
      v_message := 'Техника повреждена и выведена из эксплуатации до решения.';
    when 'repairable' then
      v_new_status := 'repairable'; v_vehicle_status := 'repair'; v_package_type := 'REPAIR_PACKAGE';
      v_message := 'Техника признана ремонтопригодной и направлена в ремонт.';
    when 'not_repairable' then
      v_new_status := 'investigating'; v_vehicle_status := 'disabled'; v_package_type := 'WRITE_OFF_PACKAGE';
      v_message := 'Техника не подлежит восстановлению. Требуется формальное решение по списанию.';
    when 'destroyed' then
      v_new_status := 'destroyed'; v_vehicle_status := 'destroyed'; v_package_type := 'VEHICLE_LOSS_PACKAGE';
      v_message := 'Зафиксировано уничтожение техники. Последние подтвержденные показатели сохранены.';
  end case;

  update public.vehicle_incidents
  set outcome=p_outcome,status=v_new_status,
      resolved_at=case when v_new_status in ('closed','destroyed') then now() else null end,
      resolved_by=case when v_new_status in ('closed','destroyed') then v_profile else null end
  where id=inc.id;

  update public.vehicles set status=v_vehicle_status,updated_at=now() where id=inc.vehicle_id;

  if v_new_status in ('closed','destroyed') then
    update public.notifications
    set is_read=true
    where employee_id is null
      and vehicle_id=inc.vehicle_id
      and notification_type='incident'
      and not is_read;
  end if;

  if p_outcome='destroyed' and inc.waybill_id is not null then
    update public.waybills
      set status='closed_by_incident',closure_reason='vehicle_loss',closed_at=coalesce(closed_at,now()),updated_at=now()
    where id=inc.waybill_id and status in ('issued','active','closed_by_driver','under_review');
  end if;

  if p_outcome='repairable' then
    select id into v_repair_id from public.repair_cases where vehicle_id=inc.vehicle_id and status not in ('closed','cancelled') order by opened_at desc limit 1;
    if v_repair_id is null then
      insert into public.repair_cases(vehicle_id,opened_at,status,notes)
      values(inc.vehicle_id,now(),'diagnostics','Создано из происшествия '||inc.id::text)
      returning id into v_repair_id;
    end if;
  end if;

  if not exists(select 1 from public.document_packages where incident_id=inc.id and package_type=v_package_type) then
    insert into public.document_packages(package_type,vehicle_id,incident_id,repair_case_id,status,metadata)
    values(v_package_type,inc.vehicle_id,inc.id,v_repair_id,'draft',jsonb_build_object('created_from_outcome',p_outcome::text));
  end if;

  insert into public.incident_updates(incident_id,update_type,body,author_profile_id)
  values(inc.id,'decision_note',v_message || case when nullif(btrim(p_note),'') is not null then ' '||btrim(p_note) else '' end,v_profile);

  return jsonb_build_object('incident_id',inc.id,'outcome',p_outcome,'status',v_new_status,'vehicle_status',v_vehicle_status,'message',v_message,'repair_case_id',v_repair_id,'package_type',v_package_type);
end
$function$;

-- One-time cleanup: remove stale incident alerts only where there is no active incident.
update public.notifications n
set is_read=true
where n.notification_type='incident'
  and not n.is_read
  and not exists (
    select 1
    from public.vehicle_incidents i
    where i.vehicle_id=n.vehicle_id
      and i.status not in ('closed','destroyed')
  );
