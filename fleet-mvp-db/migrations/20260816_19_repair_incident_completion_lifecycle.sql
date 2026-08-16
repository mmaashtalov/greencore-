create or replace function public.advance_repair_case(p_case_id uuid, p_action text)
returns void
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare
  r public.repair_cases%rowtype;
  v_profile uuid;
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
    select distinct dp.incident_id,'repair_completed','Ремонт завершён. Техника возвращена в эксплуатацию.',v_profile
      from public.document_packages dp
     where dp.repair_case_id=r.id and dp.incident_id is not null
       and not exists (
         select 1 from public.incident_updates u
          where u.incident_id=dp.incident_id and u.update_type='repair_completed'
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

create or replace function private.get_document_package_ui_impl(p_package_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  d public.document_packages%rowtype;
  inc public.vehicle_incidents%rowtype;
  rc public.repair_cases%rowtype;
  v_label text;
  v_evidence integer:=0;
  v_fact boolean:=false;
  v_decision boolean:=false;
  v_state boolean:=false;
  v_specific boolean:=false;
  v_ready boolean:=false;
  v_evidence_required boolean:=false;
  v_repair_complete boolean:=false;
  v_repair_diagnosis boolean:=false;
  v_missing jsonb:='[]'::jsonb;
  v_checklist jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into d from public.document_packages where id=p_package_id;
  if d.id is null then raise exception 'Document package not found'; end if;
  if d.incident_id is not null then select * into inc from public.vehicle_incidents where id=d.incident_id; end if;
  if d.repair_case_id is not null then select * into rc from public.repair_cases where id=d.repair_case_id; end if;
  select count(*)::integer into v_evidence from public.incident_evidence where incident_id=d.incident_id;

  v_evidence_required := d.package_type in ('VEHICLE_LOSS_PACKAGE','WRITE_OFF_PACKAGE');
  v_repair_complete := rc.id is not null and rc.status='closed';
  v_repair_diagnosis := rc.id is not null and nullif(btrim(rc.diagnosis),'') is not null;
  v_label:=case d.package_type when 'INCIDENT_PACKAGE' then 'Материалы по происшествию' when 'REPAIR_PACKAGE' then 'Материалы по ремонту' when 'VEHICLE_LOSS_PACKAGE' then 'Материалы по утрате техники' when 'WRITE_OFF_PACKAGE' then 'Материалы на списание' when 'MAINTENANCE_PACKAGE' then 'Материалы по ТО' else 'Документы' end;
  v_fact := inc.id is not null and nullif(btrim(inc.description),'') is not null and inc.occurred_at is not null;
  v_decision := inc.id is null or inc.outcome<>'unknown';
  v_state := inc.id is null or inc.last_confirmed_odometer_km is not null or inc.last_confirmed_fuel_l is not null;
  v_specific := case d.package_type
    when 'VEHICLE_LOSS_PACKAGE' then inc.outcome='destroyed' and v_evidence>0
    when 'WRITE_OFF_PACKAGE' then inc.outcome='not_repairable' and v_evidence>0
    when 'REPAIR_PACKAGE' then d.repair_case_id is not null and v_repair_complete and v_repair_diagnosis
    when 'INCIDENT_PACKAGE' then v_decision
    else true end;
  v_ready := v_fact and v_decision and v_state and v_specific;

  if not v_fact then v_missing:=v_missing||jsonb_build_array('Факт происшествия'); end if;
  if not v_decision then v_missing:=v_missing||jsonb_build_array('Решение по состоянию техники'); end if;
  if not v_state then v_missing:=v_missing||jsonb_build_array('Последнее подтверждённое состояние'); end if;
  if v_evidence_required and v_evidence=0 then v_missing:=v_missing||jsonb_build_array('Подтверждающие материалы'); end if;
  if d.package_type='REPAIR_PACKAGE' and d.repair_case_id is null then v_missing:=v_missing||jsonb_build_array('Карточка ремонта'); end if;
  if d.package_type='REPAIR_PACKAGE' and d.repair_case_id is not null and not v_repair_diagnosis then v_missing:=v_missing||jsonb_build_array('Диагноз'); end if;
  if d.package_type='REPAIR_PACKAGE' and d.repair_case_id is not null and not v_repair_complete then v_missing:=v_missing||jsonb_build_array('Завершение ремонта'); end if;

  v_checklist:=jsonb_build_array(
    jsonb_build_object('label','Факт происшествия','done',v_fact,'required',true),
    jsonb_build_object('label','Решение по состоянию','done',v_decision,'required',true),
    jsonb_build_object('label','Последнее подтверждённое состояние','done',v_state,'required',true),
    jsonb_build_object('label',case when v_evidence_required then 'Подтверждающие материалы' else 'Подтверждающие материалы (если есть)' end,'done',v_evidence>0,'count',v_evidence,'required',v_evidence_required)
  );
  if d.package_type='REPAIR_PACKAGE' then
    v_checklist:=v_checklist||jsonb_build_array(
      jsonb_build_object('label','Диагноз','done',v_repair_diagnosis,'required',true),
      jsonb_build_object('label','Ремонт завершён','done',v_repair_complete,'required',true)
    );
  end if;

  return jsonb_build_object(
    'ui_version','document_package_v3','id',d.id,'title',v_label,
    'status_label',case d.status when 'draft' then 'Собираем данные' when 'ready' then 'Данные собраны' when 'issued' then 'Сформировано' when 'archived' then 'Архив' end,
    'vehicle',(select jsonb_build_object('id',v.id,'label',v.make||' '||v.model||' №'||v.internal_number) from public.vehicles v where v.id=d.vehicle_id),
    'data_ready',v_ready,'missing',v_missing,'checklist',v_checklist,
    'repair',case when rc.id is null then null else jsonb_build_object('id',rc.id,'status',rc.status,'diagnosis',rc.diagnosis,'closed_at',rc.closed_at) end,
    'primary_action',case
      when d.status in ('issued','archived') then jsonb_build_object('id','open','label','Открыть пакет','enabled',true)
      when d.status='ready' then jsonb_build_object('id','contents','label','Состав пакета','enabled',true)
      when v_ready then jsonb_build_object('id','prepare','label','Подготовить пакет','enabled',true)
      when d.package_type='REPAIR_PACKAGE' and not v_repair_complete then jsonb_build_object('id','open_repair','label','Продолжить ремонт','enabled',rc.id is not null,'target_id',rc.id)
      when v_evidence_required and v_evidence=0 then jsonb_build_object('id','add_evidence','label','Добавить подтверждение','enabled',true)
      else jsonb_build_object('id','back_to_incident','label','Дополнить данные','enabled',true) end,
    'subtitle','Состав окончательного пакета документов определяется установленным порядком подразделения.',
    'ux_rules',jsonb_build_object('show_raw_codes',false,'one_primary_action',true,'no_legal_completeness_claim',true,'repair_package_requires_closed_repair',true)
  );
end
$function$;

create or replace function private.get_incident_ui_contract_impl(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  inc public.vehicle_incidents%rowtype;
  v jsonb;
  v_status_label text;
  v_outcome_label text;
  v_repair_id uuid;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into inc from public.vehicle_incidents where id=p_incident_id;
  if inc.id is null then raise exception 'Incident not found'; end if;
  select dp.repair_case_id into v_repair_id from public.document_packages dp where dp.incident_id=inc.id and dp.repair_case_id is not null order by dp.created_at desc limit 1;

  v_status_label := case
    when inc.outcome='damaged' and inc.status='investigating' then 'Нужно решение по технике'
    when inc.status='closed' and inc.outcome='repairable' then 'Ремонт завершён'
    else case inc.status when 'open' then 'Нужно определить состояние' when 'investigating' then 'На рассмотрении' when 'repairable' then 'Направлено в ремонт' when 'destroyed' then 'Техника уничтожена' when 'closed' then 'Закрыто' else 'Происшествие' end
  end;
  v_outcome_label := case inc.outcome when 'unknown' then 'Не определено' when 'operational' then 'Может работать' when 'damaged' then 'Повреждена' when 'repairable' then 'Подлежит ремонту' when 'not_repairable' then 'Не подлежит восстановлению' when 'destroyed' then 'Уничтожена' end;

  select jsonb_build_object(
    'ui_version','incident_card_v4','title','Происшествие','id',inc.id,
    'status_label',v_status_label,'outcome_label',v_outcome_label,'occurred_at',inc.occurred_at,'location',inc.location_name,'description',inc.description,
    'vehicle',(select jsonb_build_object('id',x.id,'label',x.make||' '||x.model||' №'||x.internal_number,'status',x.status,'status_label',case x.status when 'operational' then 'В эксплуатации' when 'reserve' then 'Резерв' when 'maintenance' then 'На ТО' when 'repair' then 'В ремонте' when 'disabled' then 'Не эксплуатируется' when 'destroyed' then 'Уничтожена' when 'written_off' then 'Списана' end) from public.vehicles x where x.id=inc.vehicle_id),
    'last_confirmed',jsonb_build_object('odometer_km',inc.last_confirmed_odometer_km,'fuel_l',inc.last_confirmed_fuel_l),
    'waybill',(select case when w.id is null then null else jsonb_build_object('id',w.id,'number',w.number,'status_label',case w.status when 'active' then 'В работе' when 'closed_by_incident' then 'Закрыт по происшествию' when 'approved' then 'Утвержден' else 'ПЛ' end) end from public.waybills w where w.id=inc.waybill_id),
    'evidence_count',(select count(*) from public.incident_evidence e where e.incident_id=inc.id),
    'updates',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'type',q.update_type,'text',q.body,'created_at',q.created_at,'author',q.author) order by q.created_at desc) from (select u.id,u.update_type,u.body,u.created_at,coalesce(e.full_name,'Администратор') author from public.incident_updates u left join public.profiles p on p.id=u.author_profile_id left join public.employees e on e.id=p.employee_id where u.incident_id=inc.id order by u.created_at desc limit 5) q),'[]'::jsonb),
    'updates_total',(select count(*) from public.incident_updates u where u.incident_id=inc.id),
    'packages',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'type',d.package_type,'status',d.status) order by d.created_at) from public.document_packages d where d.incident_id=inc.id),'[]'::jsonb),
    'next_step',case
      when inc.outcome='unknown' then jsonb_build_object('title','Определите состояние техники','detail','Сначала зафиксируйте, может ли техника работать дальше, требует ремонта или выбыла.','action_id','set_condition')
      when inc.outcome='damaged' then jsonb_build_object('title','Примите решение по технике','detail','Техника временно выведена из эксплуатации. Выберите итог: вернуть в работу, направить в ремонт или оформить выбытие.','action_id','set_condition')
      when inc.outcome='repairable' and inc.status<>'closed' then jsonb_build_object('title','Перейдите к ремонту','detail','Ремонтный случай уже создан. Продолжите работу в карточке ремонта.','action_id','open_repair')
      when inc.outcome='repairable' and inc.status='closed' then jsonb_build_object('title','Подготовьте документы по ремонту','detail','Ремонт завершён, техника возвращена в эксплуатацию. Проверьте и подготовьте комплект документов.','action_id','documents')
      when inc.outcome in ('destroyed','not_repairable') then jsonb_build_object('title','Подготовьте документы','detail','Состояние зафиксировано. Следующий шаг — комплект документов по выбытию техники.','action_id','documents')
      else jsonb_build_object('title','Решение принято','detail','Дополнительное действие по состоянию техники сейчас не требуется.','action_id','none') end,
    'primary_action',case
      when inc.outcome='unknown' then jsonb_build_object('id','set_condition','label','Указать состояние техники','enabled',true)
      when inc.outcome='damaged' then jsonb_build_object('id','set_condition','label','Принять решение','enabled',true)
      when inc.outcome='repairable' and inc.status<>'closed' then jsonb_build_object('id','open_repair','label','Открыть ремонт','enabled',true,'target_id',v_repair_id)
      when inc.outcome='repairable' and inc.status='closed' then jsonb_build_object('id','documents','label','Документы по ремонту','enabled',true)
      when inc.outcome in ('destroyed','not_repairable') then jsonb_build_object('id','documents','label','Документы','enabled',true)
      else jsonb_build_object('id','none','label','Решение принято','enabled',false) end,
    'secondary_actions',jsonb_build_array(jsonb_build_object('id','add_evidence','label','Добавить подтверждение','enabled',true),jsonb_build_object('id','add_note','label','Добавить уточнение','enabled',true)),
    'condition_choices',case
      when inc.outcome='unknown' then jsonb_build_array(jsonb_build_object('value','operational','label','Может работать'),jsonb_build_object('value','damaged','label','Повреждена — решение позже'),jsonb_build_object('value','repairable','label','Подлежит ремонту'),jsonb_build_object('value','not_repairable','label','Не подлежит восстановлению'),jsonb_build_object('value','destroyed','label','Уничтожена'))
      when inc.outcome='damaged' then jsonb_build_array(jsonb_build_object('value','operational','label','Вернуть в эксплуатацию'),jsonb_build_object('value','repairable','label','Направить в ремонт'),jsonb_build_object('value','not_repairable','label','Не подлежит восстановлению'),jsonb_build_object('value','destroyed','label','Уничтожена'))
      else '[]'::jsonb end,
    'ux_rules',jsonb_build_object('max_visible_actions',3,'show_raw_codes',false,'never_infer_fault',true,'never_invent_final_odometer_or_fuel',true,'notes_are_chronology_only',true,'damaged_requires_followup_decision',true,'repair_completion_closes_incident',true)
  ) into v;
  return v;
end
$function$;

update public.document_packages dp
   set status='draft',prepared_at=null,prepared_by=null,updated_at=now(),
       metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('reset_reason','repair_not_completed')
 where dp.package_type='REPAIR_PACKAGE'
   and dp.status='ready'
   and exists (
     select 1 from public.repair_cases r
      where r.id=dp.repair_case_id
        and (r.status<>'closed' or nullif(btrim(r.diagnosis),'') is null)
   );