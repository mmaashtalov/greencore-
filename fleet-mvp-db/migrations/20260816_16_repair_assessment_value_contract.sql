create or replace function public.get_repair_case_card(p_case_id uuid)
returns jsonb
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare result jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select jsonb_build_object(
    'ui_version','repair_case_v3','id',r.id,
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model),'number',coalesce(v.internal_number,v.registration_number),'status_label',case v.status::text when 'repair' then 'В ремонте' when 'operational' then 'В эксплуатации' when 'maintenance' then 'На ТО' else v.status::text end),
    'stage_label',case r.status::text when 'reported' then 'Неисправность принята' when 'diagnostics' then 'Диагностика' when 'waiting_parts' then 'Ожидание запчастей' when 'in_repair' then 'Ремонт' when 'testing' then 'Проверка после ремонта' when 'closed' then 'Завершено' else 'Ремонт' end,
    'opened_at',r.opened_at,'closed_at',r.closed_at,
    'defect',case when d.id is null then null else jsonb_build_object('category',d.category,'description',d.description,'severity',d.severity,'odometer_km',d.odometer_km,'reported_at',d.reported_at) end,
    'assessment',jsonb_build_object('diagnosis',r.diagnosis,'root_cause',r.root_cause,'preventability',r.preventability,'preventability_label',case r.preventability::text when 'preventable' then 'Можно было предотвратить' when 'partially_preventable' then 'Частично предотвратимо' when 'not_reasonably_preventable' then 'Разумно предотвратить нельзя' else 'Не определено' end,'preventive_action',r.preventive_action),
    'next_step',case r.status::text
      when 'reported' then jsonb_build_object('title','Начните диагностику','detail','Машина уже выведена из обычного рабочего цикла. Следующий шаг — диагностика неисправности.','action_id','start_diagnostics')
      when 'diagnostics' then jsonb_build_object('title','Определите дальнейший ремонт','detail',case when nullif(btrim(r.diagnosis),'') is null then 'Диагноз ещё не зафиксирован. Запишите результат диагностики и продолжите ремонт либо отметьте ожидание запчастей.' else 'Диагноз зафиксирован. Начните ремонт либо отметьте ожидание запчастей.' end,'action_id','start_repair')
      when 'waiting_parts' then jsonb_build_object('title','Ожидаются запчасти','detail','Когда запчасти поступят, отметьте это — карточка автоматически перейдёт к ремонту.','action_id','parts_received')
      when 'in_repair' then jsonb_build_object('title','Завершите работы','detail','После выполнения ремонта переведите машину на проверку.','action_id','start_testing')
      when 'testing' then jsonb_build_object('title',case when nullif(btrim(r.diagnosis),'') is null then 'Заполните результат диагностики' else 'Проверьте результат ремонта' end,'detail',case when nullif(btrim(r.diagnosis),'') is null then 'Без зафиксированного диагноза машину нельзя вернуть в эксплуатацию.' else 'Если проверка успешна, верните машину в эксплуатацию.' end,'action_id',case when nullif(btrim(r.diagnosis),'') is null then 'edit_assessment' else 'return_to_service' end)
      else jsonb_build_object('title','Ремонт завершён','detail','Дополнительных действий по этому ремонту сейчас не требуется.','action_id','none') end,
    'primary_action',case r.status::text when 'reported' then jsonb_build_object('id','start_diagnostics','label','Начать диагностику','enabled',true) when 'diagnostics' then jsonb_build_object('id','start_repair','label','Начать ремонт','enabled',true) when 'waiting_parts' then jsonb_build_object('id','parts_received','label','Запчасти получены','enabled',true) when 'in_repair' then jsonb_build_object('id','start_testing','label','На проверку','enabled',true) when 'testing' then jsonb_build_object('id','return_to_service','label','Вернуть в строй','enabled',r.diagnosis is not null) else jsonb_build_object('id','none','label','Завершено','enabled',false) end,
    'secondary_actions',case when r.status='diagnostics' then jsonb_build_array(jsonb_build_object('id','wait_parts','label','Нужны запчасти','enabled',true),jsonb_build_object('id','edit_assessment','label','Результат диагностики','enabled',true)) when r.status in ('waiting_parts','in_repair','testing') then jsonb_build_array(jsonb_build_object('id','edit_assessment','label','Результат и причина','enabled',true)) else '[]'::jsonb end,
    'ux_rules',jsonb_build_object('show_status_dropdown',false,'show_assessment_collapsed',true,'max_primary_actions',1,'max_secondary_actions',2,'show_next_step',true,'preserve_assessment_values',true)
  ) into result
  from public.repair_cases r join public.vehicles v on v.id=r.vehicle_id left join public.vehicle_defects d on d.id=r.defect_id
  where r.id=p_case_id;
  if result is null then raise exception 'Repair case not found'; end if;
  return result;
end $function$;