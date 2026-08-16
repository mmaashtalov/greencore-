create or replace function private.declare_repair_not_repairable_impl(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  r public.repair_cases%rowtype;
  v_incident_id uuid;
  v_incident public.vehicle_incidents%rowtype;
  v_result jsonb;
  v_writeoff_package_id uuid;
  v_reason constant text := 'По результатам диагностики восстановление техники невозможно.';
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;

  select * into r from public.repair_cases where id=p_case_id for update;
  if r.id is null then raise exception 'Repair case not found'; end if;
  if r.status in ('closed','cancelled') then raise exception 'Repair case is already finished'; end if;
  if nullif(btrim(r.diagnosis),'') is null then raise exception 'Diagnosis is required before declaring vehicle non-repairable'; end if;

  select dp.incident_id into v_incident_id
    from public.document_packages dp
   where dp.repair_case_id=r.id and dp.incident_id is not null
   order by dp.created_at desc limit 1;
  if v_incident_id is null then raise exception 'Repair case is not linked to an incident'; end if;

  select * into v_incident from public.vehicle_incidents where id=v_incident_id for update;
  if v_incident.id is null then raise exception 'Linked incident not found'; end if;
  if v_incident.outcome<>'repairable' or v_incident.status='closed' then raise exception 'Incident is not in repairable state'; end if;

  update public.repair_cases
     set status='cancelled',closed_at=coalesce(closed_at,now()),
         notes=case when nullif(btrim(notes),'') is null then v_reason else notes||E'\n'||v_reason end
   where id=r.id;

  if r.defect_id is not null then
    update public.vehicle_defects set status='closed' where id=r.defect_id and status<>'closed';
  end if;

  update public.document_packages
     set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
       'superseded_by_outcome','not_repairable',
       'superseded_at',now(),
       'source_repair_case_id',r.id
     ),updated_at=now()
   where repair_case_id=r.id and package_type='REPAIR_PACKAGE';

  v_result:=private.set_incident_vehicle_condition_impl(v_incident_id,'not_repairable'::public.vehicle_outcome,v_reason);

  select id into v_writeoff_package_id
    from public.document_packages
   where incident_id=v_incident_id and package_type='WRITE_OFF_PACKAGE'
   order by created_at desc limit 1;

  if v_writeoff_package_id is not null then
    update public.document_packages
       set repair_case_id=coalesce(repair_case_id,r.id),
           metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('source_repair_case_id',r.id),
           updated_at=now()
     where id=v_writeoff_package_id;
  end if;

  update public.notifications
     set is_read=true
   where employee_id is null and vehicle_id=r.vehicle_id and notification_type='repair' and not is_read;

  return private.get_incident_ui_contract_impl(v_incident_id);
end
$function$;

create or replace function public.declare_repair_not_repairable(p_case_id uuid)
returns jsonb
language sql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
  select private.declare_repair_not_repairable_impl(p_case_id);
$function$;

revoke all on function private.declare_repair_not_repairable_impl(uuid) from public, anon, authenticated;
revoke all on function public.declare_repair_not_repairable(uuid) from public, anon;
grant execute on function public.declare_repair_not_repairable(uuid) to authenticated;

create or replace function public.get_repair_case_card(p_case_id uuid)
returns jsonb
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare
  result jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select jsonb_build_object(
    'ui_version','repair_case_v5','id',r.id,
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model),'number',coalesce(v.internal_number,v.registration_number),'status_label',case v.status::text when 'repair' then 'В ремонте' when 'operational' then 'В эксплуатации' when 'maintenance' then 'На ТО' when 'disabled' then 'Не эксплуатируется' when 'written_off' then 'Списана' else v.status::text end),
    'stage_label',case r.status::text when 'reported' then 'Неисправность принята' when 'diagnostics' then 'Диагностика' when 'waiting_parts' then 'Ожидание запчастей' when 'in_repair' then 'Ремонт' when 'testing' then 'Проверка после ремонта' when 'closed' then 'Завершено' when 'cancelled' then 'Ремонт прекращён' else 'Ремонт' end,
    'opened_at',r.opened_at,'closed_at',r.closed_at,
    'defect',case when d.id is null then null else jsonb_build_object('category',d.category,'description',d.description,'severity',d.severity,'odometer_km',d.odometer_km,'reported_at',d.reported_at) end,
    'incident',case when i.id is null then null else jsonb_build_object('id',i.id,'outcome',i.outcome,'status',i.status) end,
    'assessment',jsonb_build_object('diagnosis',r.diagnosis,'root_cause',r.root_cause,'preventability',r.preventability,'preventability_label',case r.preventability::text when 'preventable' then 'Можно было предотвратить' when 'partially_preventable' then 'Частично предотвратимо' when 'not_reasonably_preventable' then 'Разумно предотвратить нельзя' else 'Не определено' end,'preventive_action',r.preventive_action),
    'next_step',case r.status::text
      when 'reported' then jsonb_build_object('title','Начните диагностику','detail','Машина уже выведена из обычного рабочего цикла. Следующий шаг — диагностика неисправности.','action_id','start_diagnostics')
      when 'diagnostics' then case when nullif(btrim(r.diagnosis),'') is null
        then jsonb_build_object('title','Зафиксируйте диагноз','detail','Коротко запишите, что обнаружено. После этого можно начать ремонт или продолжить ожидание запчастей.','action_id','edit_assessment')
        else jsonb_build_object('title','Определите дальнейший ремонт','detail','Диагноз зафиксирован. Начните ремонт либо отметьте ожидание запчастей. Если восстановление невозможно — завершите ремонтную ветку отдельным действием.','action_id','start_repair') end
      when 'waiting_parts' then case when nullif(btrim(r.diagnosis),'') is null
        then jsonb_build_object('title','Зафиксируйте диагноз','detail','Запчасти можно ожидать уже сейчас, но до начала ремонта диагноз должен быть записан.','action_id','edit_assessment')
        else jsonb_build_object('title','Ожидаются запчасти','detail','Когда запчасти поступят, отметьте это — карточка перейдёт к ремонту.','action_id','parts_received') end
      when 'in_repair' then jsonb_build_object('title','Завершите работы','detail','После выполнения ремонта переведите машину на проверку. Если в ходе работ выяснилась невосстановимость — завершите ремонтную ветку отдельным действием.','action_id','start_testing')
      when 'testing' then jsonb_build_object('title','Проверьте результат ремонта','detail','Если проверка успешна, верните машину в эксплуатацию. Если восстановить технику нельзя — завершите ремонтную ветку отдельным действием.','action_id','return_to_service')
      when 'cancelled' then jsonb_build_object('title','Ремонтная ветка завершена','detail','Дальнейшие действия выполняются в связанном происшествии.','action_id','open_incident')
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
    'exception_action',case
      when i.id is not null and i.outcome='repairable' and i.status<>'closed' and r.status in ('diagnostics','waiting_parts','in_repair','testing') and nullif(btrim(r.diagnosis),'') is not null
        then jsonb_build_object('id','declare_not_repairable','label','Восстановление невозможно','enabled',true,'incident_id',i.id)
      when r.status='cancelled' and i.id is not null
        then jsonb_build_object('id','open_incident','label','Открыть происшествие','enabled',true,'incident_id',i.id)
      else null end,
    'ux_rules',jsonb_build_object('show_status_dropdown',false,'show_assessment_collapsed',true,'max_primary_actions',1,'max_secondary_actions',2,'show_next_step',true,'preserve_assessment_values',true,'diagnosis_required_before_repair',true,'non_repairable_is_exception_action',true)
  ) into result
  from public.repair_cases r
  join public.vehicles v on v.id=r.vehicle_id
  left join public.vehicle_defects d on d.id=r.defect_id
  left join lateral (
    select vi.* from public.document_packages dp
    join public.vehicle_incidents vi on vi.id=dp.incident_id
    where dp.repair_case_id=r.id and dp.incident_id is not null
    order by dp.created_at desc limit 1
  ) i on true
  where r.id=p_case_id;
  if result is null then raise exception 'Repair case not found'; end if;
  return result;
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
  v_writeoff_status text;
  v_target_package_id uuid;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into inc from public.vehicle_incidents where id=p_incident_id;
  if inc.id is null then raise exception 'Incident not found'; end if;
  select dp.repair_case_id into v_repair_id from public.document_packages dp where dp.incident_id=inc.id and dp.repair_case_id is not null order by dp.created_at desc limit 1;
  select dp.status into v_writeoff_status from public.document_packages dp where dp.incident_id=inc.id and dp.package_type='WRITE_OFF_PACKAGE' order by dp.created_at desc limit 1;
  select dp.id into v_target_package_id from public.document_packages dp
   where dp.incident_id=inc.id and dp.package_type=case inc.outcome when 'repairable' then 'REPAIR_PACKAGE' when 'not_repairable' then 'WRITE_OFF_PACKAGE' when 'destroyed' then 'VEHICLE_LOSS_PACKAGE' else 'INCIDENT_PACKAGE' end
   order by dp.created_at desc limit 1;

  v_status_label := case
    when inc.outcome='damaged' and inc.status='investigating' then 'Нужно решение по технике'
    when inc.outcome='repairable' and inc.status='closed' then 'Ремонт завершён'
    when inc.outcome='not_repairable' and inc.status='closed' then 'Техника списана'
    when inc.outcome='not_repairable' and v_writeoff_status in ('issued','archived') then 'Ожидает подтверждения списания'
    else case inc.status when 'open' then 'Нужно определить состояние' when 'investigating' then 'На рассмотрении' when 'repairable' then 'Направлено в ремонт' when 'destroyed' then 'Техника уничтожена' when 'closed' then 'Закрыто' else 'Происшествие' end
  end;
  v_outcome_label := case inc.outcome when 'unknown' then 'Не определено' when 'operational' then 'Может работать' when 'damaged' then 'Повреждена' when 'repairable' then 'Подлежит ремонту' when 'not_repairable' then 'Не подлежит восстановлению' when 'destroyed' then 'Уничтожена' end;

  select jsonb_build_object(
    'ui_version','incident_card_v6','title','Происшествие','id',inc.id,
    'status_label',v_status_label,'outcome_label',v_outcome_label,'occurred_at',inc.occurred_at,'location',inc.location_name,'description',inc.description,
    'vehicle',(select jsonb_build_object('id',x.id,'label',x.make||' '||x.model||' №'||x.internal_number,'status',x.status,'status_label',case x.status when 'operational' then 'В эксплуатации' when 'reserve' then 'Резерв' when 'maintenance' then 'На ТО' when 'repair' then 'В ремонте' when 'disabled' then 'Не эксплуатируется' when 'destroyed' then 'Уничтожена' when 'written_off' then 'Списана' end) from public.vehicles x where x.id=inc.vehicle_id),
    'last_confirmed',jsonb_build_object('odometer_km',inc.last_confirmed_odometer_km,'fuel_l',inc.last_confirmed_fuel_l),
    'waybill',(select case when w.id is null then null else jsonb_build_object('id',w.id,'number',w.number,'status_label',case w.status when 'active' then 'В работе' when 'closed_by_incident' then 'Закрыт по происшествию' when 'approved' then 'Утвержден' else 'ПЛ' end,'closure_reason',w.closure_reason,'closing_odometer_km',w.closing_odometer_km,'closing_fuel_l',w.closing_fuel_l) end from public.waybills w where w.id=inc.waybill_id),
    'evidence_count',(select count(*) from public.incident_evidence e where e.incident_id=inc.id),
    'updates',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'type',q.update_type,'text',q.body,'created_at',q.created_at,'author',q.author) order by q.created_at desc) from (select u.id,u.update_type,u.body,u.created_at,coalesce(e.full_name,'Администратор') author from public.incident_updates u left join public.profiles p on p.id=u.author_profile_id left join public.employees e on e.id=p.employee_id where u.incident_id=inc.id order by u.created_at desc limit 5) q),'[]'::jsonb),
    'updates_total',(select count(*) from public.incident_updates u where u.incident_id=inc.id),
    'packages',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'type',d.package_type,'status',d.status) order by d.created_at) from public.document_packages d where d.incident_id=inc.id),'[]'::jsonb),
    'next_step',case
      when inc.outcome='unknown' then jsonb_build_object('title','Определите состояние техники','detail','Сначала зафиксируйте, может ли техника работать дальше, требует ремонта или выбыла.','action_id','set_condition')
      when inc.outcome='damaged' then jsonb_build_object('title','Примите решение по технике','detail','Техника временно выведена из эксплуатации. Выберите итог: вернуть в работу, направить в ремонт или оформить выбытие.','action_id','set_condition')
      when inc.outcome='repairable' and inc.status<>'closed' then jsonb_build_object('title','Перейдите к ремонту','detail','Ремонтный случай уже создан. Продолжите работу в карточке ремонта.','action_id','open_repair')
      when inc.outcome='repairable' and inc.status='closed' then jsonb_build_object('title','Подготовьте документы по ремонту','detail','Ремонт завершён, техника возвращена в эксплуатацию. Проверьте и сформируйте комплект документов.','action_id','documents')
      when inc.outcome='not_repairable' and inc.status='closed' then jsonb_build_object('title','Списание завершено','detail','Техника переведена в состояние «Списана». Дополнительного решения по состоянию не требуется.','action_id','none')
      when inc.outcome='not_repairable' and v_writeoff_status in ('issued','archived') then jsonb_build_object('title','Подтвердите решение о списании','detail','Пакет документов сформирован. Подтвердите списание только после фактического принятия соответствующего решения.','action_id','confirm_write_off')
      when inc.outcome='not_repairable' then jsonb_build_object('title','Подготовьте документы на списание','detail','Сначала соберите и сформируйте пакет документов. Само списание подтверждается отдельным действием.','action_id','documents')
      when inc.outcome='destroyed' then jsonb_build_object('title','Подготовьте документы','detail','Состояние зафиксировано. Следующий шаг — комплект документов по выбытию техники.','action_id','documents')
      else jsonb_build_object('title','Решение принято','detail','Дополнительное действие по состоянию техники сейчас не требуется.','action_id','none') end,
    'primary_action',case
      when inc.outcome='unknown' then jsonb_build_object('id','set_condition','label','Указать состояние техники','enabled',true)
      when inc.outcome='damaged' then jsonb_build_object('id','set_condition','label','Принять решение','enabled',true)
      when inc.outcome='repairable' and inc.status<>'closed' then jsonb_build_object('id','open_repair','label','Открыть ремонт','enabled',true,'target_id',v_repair_id)
      when inc.outcome='repairable' and inc.status='closed' then jsonb_build_object('id','documents','label','Документы по ремонту','enabled',true,'target_id',v_target_package_id)
      when inc.outcome='not_repairable' and inc.status='closed' then jsonb_build_object('id','none','label','Списание завершено','enabled',false)
      when inc.outcome='not_repairable' and v_writeoff_status in ('issued','archived') then jsonb_build_object('id','confirm_write_off','label','Подтвердить списание','enabled',true)
      when inc.outcome in ('destroyed','not_repairable') then jsonb_build_object('id','documents','label','Документы','enabled',true,'target_id',v_target_package_id)
      else jsonb_build_object('id','none','label','Решение принято','enabled',false) end,
    'secondary_actions',jsonb_build_array(jsonb_build_object('id','add_evidence','label','Добавить подтверждение','enabled',true),jsonb_build_object('id','add_note','label','Добавить уточнение','enabled',true)),
    'condition_choices',case
      when inc.outcome='unknown' then jsonb_build_array(jsonb_build_object('value','operational','label','Может работать'),jsonb_build_object('value','damaged','label','Повреждена — решение позже'),jsonb_build_object('value','repairable','label','Подлежит ремонту'),jsonb_build_object('value','not_repairable','label','Не подлежит восстановлению'),jsonb_build_object('value','destroyed','label','Уничтожена'))
      when inc.outcome='damaged' then jsonb_build_array(jsonb_build_object('value','operational','label','Вернуть в эксплуатацию'),jsonb_build_object('value','repairable','label','Направить в ремонт'),jsonb_build_object('value','not_repairable','label','Не подлежит восстановлению'),jsonb_build_object('value','destroyed','label','Уничтожена'))
      else '[]'::jsonb end,
    'ux_rules',jsonb_build_object('max_visible_actions',3,'show_raw_codes',false,'never_infer_fault',true,'never_invent_final_odometer_or_fuel',true,'notes_are_chronology_only',true,'damaged_requires_followup_decision',true,'repair_completion_closes_incident',true,'write_off_requires_formed_package_and_confirmation',true,'non_operational_outcome_closes_waybill',true,'document_action_has_exact_target',true)
  ) into v;
  return v;
end
$function$;