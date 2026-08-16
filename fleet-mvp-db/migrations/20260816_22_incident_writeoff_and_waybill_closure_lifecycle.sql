create or replace function private.set_incident_vehicle_condition_impl(p_incident_id uuid, p_outcome vehicle_outcome, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  inc public.vehicle_incidents%rowtype;
  v_profile uuid;
  v_new_status public.incident_status;
  v_vehicle_status public.vehicle_status;
  v_package_type text;
  v_repair_id uuid;
  v_message text;
  v_closure_reason public.waybill_closure_reason;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  if p_outcome='unknown' then raise exception 'Choose a concrete vehicle condition'; end if;

  select * into inc from public.vehicle_incidents where id=p_incident_id for update;
  if inc.id is null then raise exception 'Incident not found'; end if;
  if inc.status='closed' and inc.outcome is distinct from p_outcome then raise exception 'Closed incident cannot be silently changed'; end if;
  select id into v_profile from public.profiles where id=auth.uid();

  case p_outcome
    when 'operational' then
      v_new_status := 'closed'; v_vehicle_status := 'operational'; v_package_type := 'INCIDENT_PACKAGE'; v_closure_reason := null;
      v_message := 'Техника может продолжать эксплуатацию.';
    when 'damaged' then
      v_new_status := 'investigating'; v_vehicle_status := 'disabled'; v_package_type := 'INCIDENT_PACKAGE'; v_closure_reason := 'incident';
      v_message := 'Техника повреждена и выведена из эксплуатации до решения.';
    when 'repairable' then
      v_new_status := 'repairable'; v_vehicle_status := 'repair'; v_package_type := 'REPAIR_PACKAGE'; v_closure_reason := 'repair';
      v_message := 'Техника признана ремонтопригодной и направлена в ремонт.';
    when 'not_repairable' then
      v_new_status := 'investigating'; v_vehicle_status := 'disabled'; v_package_type := 'WRITE_OFF_PACKAGE'; v_closure_reason := 'incident';
      v_message := 'Техника не подлежит восстановлению. Требуется формальное решение по списанию.';
    when 'destroyed' then
      v_new_status := 'destroyed'; v_vehicle_status := 'destroyed'; v_package_type := 'VEHICLE_LOSS_PACKAGE'; v_closure_reason := 'vehicle_loss';
      v_message := 'Зафиксировано уничтожение техники. Последние подтверждённые показатели сохранены.';
  end case;

  update public.vehicle_incidents
     set outcome=p_outcome,status=v_new_status,
         resolved_at=case when v_new_status in ('closed','destroyed') then now() else null end,
         resolved_by=case when v_new_status in ('closed','destroyed') then v_profile else null end
   where id=inc.id;

  update public.vehicles set status=v_vehicle_status,updated_at=now() where id=inc.vehicle_id;

  if p_outcome<>'operational' and inc.waybill_id is not null then
    update public.waybills
       set status='closed_by_incident',closure_reason=v_closure_reason,
           closed_at=coalesce(closed_at,now()),
           closing_odometer_km=coalesce(closing_odometer_km,inc.last_confirmed_odometer_km),
           closing_fuel_l=coalesce(closing_fuel_l,inc.last_confirmed_fuel_l),
           updated_at=now()
     where id=inc.waybill_id
       and status in ('issued','active','closed_by_driver','under_review','needs_correction');
  end if;

  if v_new_status in ('closed','destroyed') then
    update public.notifications
       set is_read=true
     where employee_id is null and vehicle_id=inc.vehicle_id and notification_type='incident' and not is_read;
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
  elsif p_outcome='repairable' and v_repair_id is not null then
    update public.document_packages
       set repair_case_id=coalesce(repair_case_id,v_repair_id),updated_at=now()
     where incident_id=inc.id and package_type='REPAIR_PACKAGE';
  end if;

  insert into public.incident_updates(incident_id,update_type,body,author_profile_id)
  values(inc.id,'decision_note',v_message || case when nullif(btrim(p_note),'') is not null then ' '||btrim(p_note) else '' end,v_profile);

  return jsonb_build_object('incident_id',inc.id,'outcome',p_outcome,'status',v_new_status,'vehicle_status',v_vehicle_status,'message',v_message,'repair_case_id',v_repair_id,'package_type',v_package_type);
end
$function$;

create or replace function private.complete_vehicle_write_off_impl(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  inc public.vehicle_incidents%rowtype;
  v_profile uuid;
  v_package_status text;
  v_note constant text := 'Решение о списании подтверждено. Техника переведена в состояние «Списана».';
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into inc from public.vehicle_incidents where id=p_incident_id for update;
  if inc.id is null then raise exception 'Incident not found'; end if;
  if inc.outcome<>'not_repairable' then raise exception 'Write-off is allowed only for non-repairable vehicle outcome'; end if;
  if inc.status='closed' and exists(select 1 from public.vehicles v where v.id=inc.vehicle_id and v.status='written_off') then
    return private.get_incident_ui_contract_impl(p_incident_id);
  end if;

  select d.status into v_package_status
    from public.document_packages d
   where d.incident_id=inc.id and d.package_type='WRITE_OFF_PACKAGE'
   order by d.created_at desc limit 1;
  if v_package_status is null or v_package_status not in ('issued','archived') then
    raise exception 'Write-off package must be formed before confirmation';
  end if;

  select id into v_profile from public.profiles where id=auth.uid();
  update public.vehicles set status='written_off',updated_at=now() where id=inc.vehicle_id;
  update public.vehicle_incidents
     set status='closed',resolved_at=coalesce(resolved_at,now()),resolved_by=coalesce(resolved_by,v_profile)
   where id=inc.id;

  insert into public.incident_updates(incident_id,update_type,body,author_profile_id)
  select inc.id,'status_note',v_note,v_profile
   where not exists(select 1 from public.incident_updates u where u.incident_id=inc.id and u.update_type='status_note' and u.body=v_note);

  update public.notifications
     set is_read=true
   where employee_id is null and vehicle_id=inc.vehicle_id and notification_type='incident' and not is_read;

  return private.get_incident_ui_contract_impl(p_incident_id);
end
$function$;

create or replace function public.complete_vehicle_write_off(p_incident_id uuid)
returns jsonb
language sql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
  select private.complete_vehicle_write_off_impl(p_incident_id);
$function$;

revoke all on function private.complete_vehicle_write_off_impl(uuid) from public, anon, authenticated;
revoke all on function public.complete_vehicle_write_off(uuid) from public, anon;
grant execute on function public.complete_vehicle_write_off(uuid) to authenticated;

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
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into inc from public.vehicle_incidents where id=p_incident_id;
  if inc.id is null then raise exception 'Incident not found'; end if;
  select dp.repair_case_id into v_repair_id from public.document_packages dp where dp.incident_id=inc.id and dp.repair_case_id is not null order by dp.created_at desc limit 1;
  select dp.status into v_writeoff_status from public.document_packages dp where dp.incident_id=inc.id and dp.package_type='WRITE_OFF_PACKAGE' order by dp.created_at desc limit 1;

  v_status_label := case
    when inc.outcome='damaged' and inc.status='investigating' then 'Нужно решение по технике'
    when inc.outcome='repairable' and inc.status='closed' then 'Ремонт завершён'
    when inc.outcome='not_repairable' and inc.status='closed' then 'Техника списана'
    when inc.outcome='not_repairable' and v_writeoff_status in ('issued','archived') then 'Ожидает подтверждения списания'
    else case inc.status when 'open' then 'Нужно определить состояние' when 'investigating' then 'На рассмотрении' when 'repairable' then 'Направлено в ремонт' when 'destroyed' then 'Техника уничтожена' when 'closed' then 'Закрыто' else 'Происшествие' end
  end;
  v_outcome_label := case inc.outcome when 'unknown' then 'Не определено' when 'operational' then 'Может работать' when 'damaged' then 'Повреждена' when 'repairable' then 'Подлежит ремонту' when 'not_repairable' then 'Не подлежит восстановлению' when 'destroyed' then 'Уничтожена' end;

  select jsonb_build_object(
    'ui_version','incident_card_v5','title','Происшествие','id',inc.id,
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
      when inc.outcome='repairable' and inc.status='closed' then jsonb_build_object('id','documents','label','Документы по ремонту','enabled',true)
      when inc.outcome='not_repairable' and inc.status='closed' then jsonb_build_object('id','none','label','Списание завершено','enabled',false)
      when inc.outcome='not_repairable' and v_writeoff_status in ('issued','archived') then jsonb_build_object('id','confirm_write_off','label','Подтвердить списание','enabled',true)
      when inc.outcome in ('destroyed','not_repairable') then jsonb_build_object('id','documents','label','Документы','enabled',true)
      else jsonb_build_object('id','none','label','Решение принято','enabled',false) end,
    'secondary_actions',jsonb_build_array(jsonb_build_object('id','add_evidence','label','Добавить подтверждение','enabled',true),jsonb_build_object('id','add_note','label','Добавить уточнение','enabled',true)),
    'condition_choices',case
      when inc.outcome='unknown' then jsonb_build_array(jsonb_build_object('value','operational','label','Может работать'),jsonb_build_object('value','damaged','label','Повреждена — решение позже'),jsonb_build_object('value','repairable','label','Подлежит ремонту'),jsonb_build_object('value','not_repairable','label','Не подлежит восстановлению'),jsonb_build_object('value','destroyed','label','Уничтожена'))
      when inc.outcome='damaged' then jsonb_build_array(jsonb_build_object('value','operational','label','Вернуть в эксплуатацию'),jsonb_build_object('value','repairable','label','Направить в ремонт'),jsonb_build_object('value','not_repairable','label','Не подлежит восстановлению'),jsonb_build_object('value','destroyed','label','Уничтожена'))
      else '[]'::jsonb end,
    'ux_rules',jsonb_build_object('max_visible_actions',3,'show_raw_codes',false,'never_infer_fault',true,'never_invent_final_odometer_or_fuel',true,'notes_are_chronology_only',true,'damaged_requires_followup_decision',true,'repair_completion_closes_incident',true,'write_off_requires_formed_package_and_confirmation',true,'non_operational_outcome_closes_waybill',true)
  ) into v;
  return v;
end
$function$;

create or replace function private.get_incidents_ui_impl()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  return jsonb_build_object(
    'ui_version','incidents_list_v3','title','Происшествия',
    'attention',coalesce((select jsonb_agg(jsonb_build_object(
        'id',i.id,'vehicle',v.make||' '||v.model||' №'||v.internal_number,'occurred_at',i.occurred_at,
        'status_label',case
          when i.outcome='unknown' then 'Нужно указать состояние'
          when i.outcome='damaged' then 'Нужно принять решение'
          when i.outcome='repairable' and i.status='closed' then 'Документы по ремонту'
          when i.outcome='not_repairable' and exists(select 1 from public.document_packages d where d.incident_id=i.id and d.package_type='WRITE_OFF_PACKAGE' and d.status in ('issued','archived')) then 'Подтвердить списание'
          when i.outcome in ('destroyed','not_repairable') then 'Нужны документы'
          else 'Требует внимания' end,
        'primary_action',jsonb_build_object('id','open','label','Открыть','enabled',true)
      ) order by i.occurred_at desc)
      from public.vehicle_incidents i join public.vehicles v on v.id=i.vehicle_id
      where (i.outcome in ('unknown','damaged') and i.status in ('open','investigating'))
         or (i.outcome='repairable' and i.status='closed' and exists(select 1 from public.document_packages d where d.incident_id=i.id and d.package_type='REPAIR_PACKAGE' and d.status in ('draft','ready')))
         or (i.outcome='destroyed' and exists(select 1 from public.document_packages d where d.incident_id=i.id and d.package_type='VEHICLE_LOSS_PACKAGE' and d.status in ('draft','ready')))
         or (i.outcome='not_repairable' and i.status<>'closed')),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'vehicle',q.vehicle,'occurred_at',q.occurred_at,'status_label',q.status_label,'primary_action',jsonb_build_object('id','open','label','Открыть','enabled',true)) order by q.occurred_at desc)
      from (select i.id,v.make||' '||v.model||' №'||v.internal_number vehicle,i.occurred_at,
          case when i.outcome='not_repairable' and i.status='closed' then 'Списана' else case i.outcome when 'operational' then 'Закрыто' when 'repairable' then case when i.status='closed' then 'Ремонт завершён' else 'В ремонте' end when 'destroyed' then 'Уничтожена' when 'not_repairable' then 'Не подлежит восстановлению' when 'damaged' then 'Повреждена' else 'На рассмотрении' end end status_label
        from public.vehicle_incidents i join public.vehicles v on v.id=i.vehicle_id
        where not (
          (i.outcome in ('unknown','damaged') and i.status in ('open','investigating'))
          or (i.outcome='repairable' and i.status='closed' and exists(select 1 from public.document_packages d where d.incident_id=i.id and d.package_type='REPAIR_PACKAGE' and d.status in ('draft','ready')))
          or (i.outcome='destroyed' and exists(select 1 from public.document_packages d where d.incident_id=i.id and d.package_type='VEHICLE_LOSS_PACKAGE' and d.status in ('draft','ready')))
          or (i.outcome='not_repairable' and i.status<>'closed')
        )
        order by i.occurred_at desc limit 10) q),'[]'::jsonb),
    'primary_action',jsonb_build_object('id','new_incident','label','Зафиксировать происшествие','enabled',true),
    'ux_rules',jsonb_build_object('no_filters_on_first_screen',true,'attention_first',true,'show_raw_codes',false,'damaged_requires_followup_decision',true,'documents_remain_attention_until_formed',true,'write_off_requires_confirmation',true)
  );
end
$function$;