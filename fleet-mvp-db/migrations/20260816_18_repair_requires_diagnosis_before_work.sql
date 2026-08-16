create or replace function public.advance_repair_case(p_case_id uuid, p_action text)
returns void
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare r public.repair_cases%rowtype;
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
    update public.notifications set is_read=true where employee_id is null and vehicle_id=r.vehicle_id and notification_type='repair' and not is_read;
  else
    raise exception 'Action is not allowed for current repair stage';
  end if;
end $function$;

create or replace function public.get_repair_case_card(p_case_id uuid)
returns jsonb
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare result jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select jsonb_build_object(
    'ui_version','repair_case_v4','id',r.id,
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model),'number',coalesce(v.internal_number,v.registration_number),'status_label',case v.status::text when 'repair' then 'В ремонте' when 'operational' then 'В эксплуатации' when 'maintenance' then 'На ТО' else v.status::text end),
    'stage_label',case r.status::text when 'reported' then 'Неисправность принята' when 'diagnostics' then 'Диагностика' when 'waiting_parts' then 'Ожидание запчастей' when 'in_repair' then 'Ремонт' when 'testing' then 'Проверка после ремонта' when 'closed' then 'Завершено' else 'Ремонт' end,
    'opened_at',r.opened_at,'closed_at',r.closed_at,
    'defect',case when d.id is null then null else jsonb_build_object('category',d.category,'description',d.description,'severity',d.severity,'odometer_km',d.odometer_km,'reported_at',d.reported_at) end,
    'assessment',jsonb_build_object('diagnosis',r.diagnosis,'root_cause',r.root_cause,'preventability',r.preventability,'preventability_label',case r.preventability::text when 'preventable' then 'Можно было предотвратить' when 'partially_preventable' then 'Частично предотвратимо' when 'not_reasonably_preventable' then 'Разумно предотвратить нельзя' else 'Не определено' end,'preventive_action',r.preventive_action),
    'next_step',case r.status::text
      when 'reported' then jsonb_build_object('title','Начните диагностику','detail','Машина уже выведена из обычного рабочего цикла. Следующий шаг — диагностика неисправности.','action_id','start_diagnostics')
      when 'diagnostics' then case when nullif(btrim(r.diagnosis),'') is null
        then jsonb_build_object('title','Зафиксируйте диагноз','detail','Коротко запишите, что обнаружено. После этого можно начать ремонт или продолжить ожидание запчастей.','action_id','edit_assessment')
        else jsonb_build_object('title','Определите дальнейший ремонт','detail','Диагноз зафиксирован. Начните ремонт либо отметьте ожидание запчастей.','action_id','start_repair') end
      when 'waiting_parts' then case when nullif(btrim(r.diagnosis),'') is null
        then jsonb_build_object('title','Зафиксируйте диагноз','detail','Запчасти можно ожидать уже сейчас, но до начала ремонта диагноз должен быть записан.','action_id','edit_assessment')
        else jsonb_build_object('title','Ожидаются запчасти','detail','Когда запчасти поступят, отметьте это — карточка перейдёт к ремонту.','action_id','parts_received') end
      when 'in_repair' then jsonb_build_object('title','Завершите работы','detail','После выполнения ремонта переведите машину на проверку.','action_id','start_testing')
      when 'testing' then jsonb_build_object('title','Проверьте результат ремонта','detail','Если проверка успешна, верните машину в эксплуатацию.','action_id','return_to_service')
      else jsonb_build_object('title','Ремонт завершён','detail','Дополнительных действий по этому ремонту сейчас не требуется.','action_id','none') end,
    'primary_action',case r.status::text
      when 'reported' then jsonb_build_object('id','start_diagnostics','label','Начать диагностику','enabled',true)
      when 'diagnostics' then case when nullif(btrim(r.diagnosis),'') is null then jsonb_build_object('id','edit_assessment','label','Записать диагноз','enabled',true) else jsonb_build_object('id','start_repair','label','Начать ремонт','enabled',true) end
      when 'waiting_parts' then case when nullif(btrim(r.diagnosis),'') is null then jsonb_build_object('id','edit_assessment','label','Записать диагноз','enabled',true) else jsonb_build_object('id','parts_received','label','Запчасти получены','enabled',true) end
      when 'in_repair' then jsonb_build_object('id','start_testing','label','На проверку','enabled',true)
      when 'testing' then jsonb_build_object('id','return_to_service','label','Вернуть в строй','enabled',true)
      else jsonb_build_object('id','none','label','Завершено','enabled',false) end,
    'secondary_actions',case r.status::text
      when 'diagnostics' then case when nullif(btrim(r.diagnosis),'') is null then jsonb_build_array(jsonb_build_object('id','wait_parts','label','Нужны запчасти','enabled',true)) else jsonb_build_array(jsonb_build_object('id','wait_parts','label','Нужны запчасти','enabled',true),jsonb_build_object('id','edit_assessment','label','Изменить диагноз','enabled',true)) end
      when 'waiting_parts' then case when nullif(btrim(r.diagnosis),'') is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('id','edit_assessment','label','Изменить диагноз','enabled',true)) end
      when 'in_repair' then jsonb_build_array(jsonb_build_object('id','edit_assessment','label','Причина и профилактика','enabled',true))
      when 'testing' then jsonb_build_array(jsonb_build_object('id','edit_assessment','label','Результат и причина','enabled',true))
      else '[]'::jsonb end,
    'ux_rules',jsonb_build_object('show_status_dropdown',false,'show_assessment_collapsed',true,'max_primary_actions',1,'max_secondary_actions',2,'show_next_step',true,'preserve_assessment_values',true,'diagnosis_required_before_repair',true)
  ) into result
  from public.repair_cases r join public.vehicles v on v.id=r.vehicle_id left join public.vehicle_defects d on d.id=r.defect_id
  where r.id=p_case_id;
  if result is null then raise exception 'Repair case not found'; end if;
  return result;
end $function$;