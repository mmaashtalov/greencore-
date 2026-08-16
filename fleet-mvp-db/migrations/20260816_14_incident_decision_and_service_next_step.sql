create or replace function private.get_incident_ui_contract_impl(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare inc public.vehicle_incidents%rowtype; v jsonb; v_status_label text; v_outcome_label text; begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into inc from public.vehicle_incidents where id=p_incident_id;
  if inc.id is null then raise exception 'Incident not found'; end if;

  v_status_label := case
    when inc.outcome='damaged' and inc.status='investigating' then 'Нужно решение по технике'
    else case inc.status when 'open' then 'Нужно определить состояние' when 'investigating' then 'На рассмотрении' when 'repairable' then 'Направлено в ремонт' when 'destroyed' then 'Техника уничтожена' when 'closed' then 'Закрыто' else 'Происшествие' end
  end;
  v_outcome_label := case inc.outcome when 'unknown' then 'Не определено' when 'operational' then 'Может работать' when 'damaged' then 'Повреждена' when 'repairable' then 'Подлежит ремонту' when 'not_repairable' then 'Не подлежит восстановлению' when 'destroyed' then 'Уничтожена' end;

  select jsonb_build_object(
    'ui_version','incident_card_v3','title','Происшествие','id',inc.id,
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
      when inc.outcome='repairable' then jsonb_build_object('title','Перейдите к ремонту','detail','Ремонтный случай уже создан. Продолжите работу в карточке ремонта.','action_id','open_repair')
      when inc.outcome in ('destroyed','not_repairable') then jsonb_build_object('title','Подготовьте документы','detail','Состояние зафиксировано. Следующий шаг — комплект документов по выбытию техники.','action_id','documents')
      else jsonb_build_object('title','Решение принято','detail','Дополнительное действие по состоянию техники сейчас не требуется.','action_id','none') end,
    'primary_action',case when inc.outcome='unknown' then jsonb_build_object('id','set_condition','label','Указать состояние техники','enabled',true) when inc.outcome='damaged' then jsonb_build_object('id','set_condition','label','Принять решение','enabled',true) when inc.outcome='repairable' then jsonb_build_object('id','open_repair','label','Открыть ремонт','enabled',true) when inc.outcome in ('destroyed','not_repairable') then jsonb_build_object('id','documents','label','Документы','enabled',true) else jsonb_build_object('id','none','label','Решение принято','enabled',false) end,
    'secondary_actions',jsonb_build_array(jsonb_build_object('id','add_evidence','label','Добавить подтверждение','enabled',true),jsonb_build_object('id','add_note','label','Добавить уточнение','enabled',true)),
    'condition_choices',case
      when inc.outcome='unknown' then jsonb_build_array(jsonb_build_object('value','operational','label','Может работать'),jsonb_build_object('value','damaged','label','Повреждена — решение позже'),jsonb_build_object('value','repairable','label','Подлежит ремонту'),jsonb_build_object('value','not_repairable','label','Не подлежит восстановлению'),jsonb_build_object('value','destroyed','label','Уничтожена'))
      when inc.outcome='damaged' then jsonb_build_array(jsonb_build_object('value','operational','label','Вернуть в эксплуатацию'),jsonb_build_object('value','repairable','label','Направить в ремонт'),jsonb_build_object('value','not_repairable','label','Не подлежит восстановлению'),jsonb_build_object('value','destroyed','label','Уничтожена'))
      else '[]'::jsonb end,
    'ux_rules',jsonb_build_object('max_visible_actions',3,'show_raw_codes',false,'never_infer_fault',true,'never_invent_final_odometer_or_fuel',true,'notes_are_chronology_only',true,'damaged_requires_followup_decision',true)
  ) into v;
  return v;
end $function$;

create or replace function private.get_incidents_ui_impl()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  return jsonb_build_object(
    'ui_version','incidents_list_v2','title','Происшествия',
    'attention',coalesce((select jsonb_agg(jsonb_build_object(
        'id',i.id,'vehicle',v.make||' '||v.model||' №'||v.internal_number,'occurred_at',i.occurred_at,
        'status_label',case when i.outcome='unknown' then 'Нужно указать состояние' when i.outcome='damaged' then 'Нужно принять решение' when i.outcome in ('destroyed','not_repairable') then 'Нужны документы' else 'Требует внимания' end,
        'primary_action',case when i.outcome='unknown' then jsonb_build_object('id','set_condition','label','Указать состояние','enabled',true) when i.outcome='damaged' then jsonb_build_object('id','set_condition','label','Принять решение','enabled',true) else jsonb_build_object('id','open','label','Открыть','enabled',true) end
      ) order by i.occurred_at desc)
      from public.vehicle_incidents i join public.vehicles v on v.id=i.vehicle_id
      where (i.outcome in ('unknown','damaged') and i.status in ('open','investigating'))
         or exists(select 1 from public.document_packages d where d.incident_id=i.id and d.package_type in ('VEHICLE_LOSS_PACKAGE','WRITE_OFF_PACKAGE') and d.status='draft')),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'vehicle',q.vehicle,'occurred_at',q.occurred_at,'status_label',q.status_label,'primary_action',jsonb_build_object('id','open','label','Открыть','enabled',true)) order by q.occurred_at desc)
      from (select i.id,v.make||' '||v.model||' №'||v.internal_number vehicle,i.occurred_at,
          case i.outcome when 'operational' then 'Закрыто' when 'repairable' then 'В ремонте' when 'destroyed' then 'Уничтожена' when 'not_repairable' then 'Не подлежит восстановлению' when 'damaged' then 'Повреждена' else 'На рассмотрении' end status_label
        from public.vehicle_incidents i join public.vehicles v on v.id=i.vehicle_id
        where not ((i.outcome in ('unknown','damaged') and i.status in ('open','investigating')) or exists(select 1 from public.document_packages d where d.incident_id=i.id and d.package_type in ('VEHICLE_LOSS_PACKAGE','WRITE_OFF_PACKAGE') and d.status='draft'))
        order by i.occurred_at desc limit 10) q),'[]'::jsonb),
    'primary_action',jsonb_build_object('id','new_incident','label','Зафиксировать происшествие','enabled',true),
    'ux_rules',jsonb_build_object('no_filters_on_first_screen',true,'attention_first',true,'show_raw_codes',false,'damaged_requires_followup_decision',true)
  );
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
    'ui_version','repair_case_v2','id',r.id,
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model),'number',coalesce(v.internal_number,v.registration_number),'status_label',case v.status::text when 'repair' then 'В ремонте' when 'operational' then 'В эксплуатации' when 'maintenance' then 'На ТО' else v.status::text end),
    'stage_label',case r.status::text when 'reported' then 'Неисправность принята' when 'diagnostics' then 'Диагностика' when 'waiting_parts' then 'Ожидание запчастей' when 'in_repair' then 'Ремонт' when 'testing' then 'Проверка после ремонта' when 'closed' then 'Завершено' else 'Ремонт' end,
    'opened_at',r.opened_at,'closed_at',r.closed_at,
    'defect',case when d.id is null then null else jsonb_build_object('category',d.category,'description',d.description,'severity',d.severity,'odometer_km',d.odometer_km,'reported_at',d.reported_at) end,
    'assessment',jsonb_build_object('diagnosis',r.diagnosis,'root_cause',r.root_cause,'preventability_label',case r.preventability::text when 'preventable' then 'Можно было предотвратить' when 'partially_preventable' then 'Частично предотвратимо' when 'not_reasonably_preventable' then 'Разумно предотвратить нельзя' else 'Не определено' end,'preventive_action',r.preventive_action),
    'next_step',case r.status::text
      when 'reported' then jsonb_build_object('title','Начните диагностику','detail','Машина уже выведена из обычного рабочего цикла. Следующий шаг — диагностика неисправности.','action_id','start_diagnostics')
      when 'diagnostics' then jsonb_build_object('title','Определите дальнейший ремонт','detail',case when nullif(btrim(r.diagnosis),'') is null then 'Диагноз ещё не зафиксирован. Запишите результат диагностики и продолжите ремонт либо отметьте ожидание запчастей.' else 'Диагноз зафиксирован. Начните ремонт либо отметьте ожидание запчастей.' end,'action_id','start_repair')
      when 'waiting_parts' then jsonb_build_object('title','Ожидаются запчасти','detail','Когда запчасти поступят, отметьте это — карточка автоматически перейдёт к ремонту.','action_id','parts_received')
      when 'in_repair' then jsonb_build_object('title','Завершите работы','detail','После выполнения ремонта переведите машину на проверку.','action_id','start_testing')
      when 'testing' then jsonb_build_object('title',case when nullif(btrim(r.diagnosis),'') is null then 'Заполните результат диагностики' else 'Проверьте результат ремонта' end,'detail',case when nullif(btrim(r.diagnosis),'') is null then 'Без зафиксированного диагноза машину нельзя вернуть в эксплуатацию.' else 'Если проверка успешна, верните машину в эксплуатацию.' end,'action_id',case when nullif(btrim(r.diagnosis),'') is null then 'edit_assessment' else 'return_to_service' end)
      else jsonb_build_object('title','Ремонт завершён','detail','Дополнительных действий по этому ремонту сейчас не требуется.','action_id','none') end,
    'primary_action',case r.status::text when 'reported' then jsonb_build_object('id','start_diagnostics','label','Начать диагностику','enabled',true) when 'diagnostics' then jsonb_build_object('id','start_repair','label','Начать ремонт','enabled',true) when 'waiting_parts' then jsonb_build_object('id','parts_received','label','Запчасти получены','enabled',true) when 'in_repair' then jsonb_build_object('id','start_testing','label','На проверку','enabled',true) when 'testing' then jsonb_build_object('id','return_to_service','label','Вернуть в строй','enabled',r.diagnosis is not null) else jsonb_build_object('id','none','label','Завершено','enabled',false) end,
    'secondary_actions',case when r.status='diagnostics' then jsonb_build_array(jsonb_build_object('id','wait_parts','label','Нужны запчасти','enabled',true),jsonb_build_object('id','edit_assessment','label','Результат диагностики','enabled',true)) when r.status in ('waiting_parts','in_repair','testing') then jsonb_build_array(jsonb_build_object('id','edit_assessment','label','Результат и причина','enabled',true)) else '[]'::jsonb end,
    'ux_rules',jsonb_build_object('show_status_dropdown',false,'show_assessment_collapsed',true,'max_primary_actions',1,'max_secondary_actions',2,'show_next_step',true)
  ) into result
  from public.repair_cases r join public.vehicles v on v.id=r.vehicle_id left join public.vehicle_defects d on d.id=r.defect_id
  where r.id=p_case_id;
  if result is null then raise exception 'Repair case not found'; end if;
  return result;
end $function$;