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
    'ui_version','document_package_v4','id',d.id,'title',v_label,
    'status_label',case d.status when 'draft' then 'Собираем данные' when 'ready' then 'Данные собраны' when 'issued' then 'Пакет сформирован' when 'archived' then 'Архив' else d.status end,
    'vehicle',(select jsonb_build_object('id',v.id,'label',v.make||' '||v.model||' №'||v.internal_number) from public.vehicles v where v.id=d.vehicle_id),
    'data_ready',v_ready,'missing',v_missing,'checklist',v_checklist,
    'repair',case when rc.id is null then null else jsonb_build_object('id',rc.id,'status',rc.status,'diagnosis',rc.diagnosis,'closed_at',rc.closed_at) end,
    'prepared_at',d.prepared_at,'formed_at',d.generated_at,
    'primary_action',case
      when d.status='archived' then jsonb_build_object('id','contents','label','Состав пакета','enabled',true)
      when d.status='issued' then jsonb_build_object('id','contents','label','Состав сформированного пакета','enabled',true)
      when d.status='ready' then jsonb_build_object('id','finalize','label','Сформировать пакет','enabled',true)
      when v_ready then jsonb_build_object('id','prepare','label','Подготовить пакет','enabled',true)
      when d.package_type='REPAIR_PACKAGE' and not v_repair_complete then jsonb_build_object('id','open_repair','label','Продолжить ремонт','enabled',rc.id is not null,'target_id',rc.id)
      when v_evidence_required and v_evidence=0 then jsonb_build_object('id','add_evidence','label','Добавить подтверждение','enabled',true)
      else jsonb_build_object('id','back_to_incident','label','Дополнить данные','enabled',true) end,
    'subtitle','Состав окончательного пакета документов определяется установленным порядком подразделения.',
    'ux_rules',jsonb_build_object('show_raw_codes',false,'one_primary_action',true,'no_legal_completeness_claim',true,'repair_package_requires_closed_repair',true,'package_flow','draft_ready_issued')
  );
end
$function$;

create or replace function private.finalize_document_package_impl(p_package_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  d public.document_packages%rowtype;
  u jsonb;
  v_profile uuid;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into d from public.document_packages where id=p_package_id for update;
  if d.id is null then raise exception 'Document package not found'; end if;
  if d.status='issued' then return private.get_document_package_ui_impl(p_package_id); end if;
  if d.status='archived' then raise exception 'Package is archived'; end if;
  if d.status<>'ready' then raise exception 'Package must be prepared before finalization'; end if;

  u:=private.get_document_package_ui_impl(p_package_id);
  if coalesce((u->>'data_ready')::boolean,false)=false then raise exception 'Package data is incomplete'; end if;
  select id into v_profile from public.profiles where id=auth.uid();
  update public.document_packages
     set status='issued',generated_at=coalesce(generated_at,now()),generated_by=coalesce(generated_by,v_profile),updated_at=now(),
         metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('mvp_formed_at',now())
   where id=p_package_id;
  return private.get_document_package_ui_impl(p_package_id);
end
$function$;

create or replace function public.finalize_document_package(p_package_id uuid)
returns jsonb
language sql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
  select private.finalize_document_package_impl(p_package_id);
$function$;

revoke all on function private.finalize_document_package_impl(uuid) from public, anon, authenticated;
revoke all on function public.finalize_document_package(uuid) from public, anon;
grant execute on function public.finalize_document_package(uuid) to authenticated;