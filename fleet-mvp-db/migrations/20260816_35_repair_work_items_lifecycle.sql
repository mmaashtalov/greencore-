alter table public.repair_work_items add column if not exists recorded_by uuid references public.profiles(id) on delete set null;

create or replace function public.record_repair_work_item(p_case_id uuid,p_description text,p_part_name text,p_quantity numeric,p_cost_amount numeric)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare r public.repair_cases%rowtype; v_id uuid; v_part text; v_qty numeric;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.repair_cases where id=p_case_id for update;
  if r.id is null then raise exception 'Repair case not found'; end if;
  if r.status<>'in_repair' then raise exception 'Work can be recorded only while repair is in progress'; end if;
  if nullif(btrim(p_description),'') is null then raise exception 'Work description is required'; end if;
  v_part:=nullif(btrim(p_part_name),'');
  if p_quantity is not null and p_quantity<=0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_cost_amount is not null and p_cost_amount<0 then raise exception 'Cost cannot be negative'; end if;
  if v_part is null and p_quantity is not null then raise exception 'Part name is required when quantity is specified'; end if;
  v_qty:=case when v_part is null then null else coalesce(p_quantity,1) end;
  insert into public.repair_work_items(repair_case_id,description,part_name,quantity,cost_amount,completed_at,recorded_by)
  values(r.id,btrim(p_description),v_part,v_qty,p_cost_amount,now(),auth.uid()) returning id into v_id;
  return v_id;
end
$function$;

create or replace function public.advance_repair_case(p_case_id uuid, p_action text)
returns void
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare
  r public.repair_cases%rowtype;
  v_profile uuid;
  v_completion_note constant text := 'Ремонт завершён. Техника возвращена в эксплуатацию.';
  v_completed_work integer:=0;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.repair_cases where id=p_case_id for update;
  if r.id is null then raise exception 'Repair case not found'; end if;
  select id into v_profile from public.profiles where id=auth.uid();
  select count(*)::int into v_completed_work from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null;

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
    if v_completed_work=0 then raise exception 'Record at least one completed work item before testing'; end if;
    update public.repair_cases set status='testing' where id=r.id;
  elsif p_action='resume_repair' and r.status='testing' then
    update public.repair_cases set status='in_repair' where id=r.id;
  elsif p_action='return_to_service' and r.status='testing' then
    if nullif(btrim(r.diagnosis),'') is null then raise exception 'Diagnosis is required before return to service'; end if;
    if v_completed_work=0 then raise exception 'Record at least one completed work item before return to service'; end if;
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
    'ui_version','repair_case_v6','id',r.id,
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model),'number',coalesce(v.internal_number,v.registration_number),'status_label',case v.status::text when 'repair' then 'В ремонте' when 'operational' then 'В эксплуатации' when 'maintenance' then 'На ТО' when 'disabled' then 'Не эксплуатируется' when 'written_off' then 'Списана' else v.status::text end),
    'stage_label',case r.status::text when 'reported' then 'Неисправность принята' when 'diagnostics' then 'Диагностика' when 'waiting_parts' then 'Ожидание запчастей' when 'in_repair' then 'Ремонт' when 'testing' then 'Проверка после ремонта' when 'closed' then 'Завершено' when 'cancelled' then 'Ремонт прекращён' else 'Ремонт' end,
    'opened_at',r.opened_at,'closed_at',r.closed_at,
    'defect',case when d.id is null then null else jsonb_build_object('category',d.category,'description',d.description,'severity',d.severity,'odometer_km',d.odometer_km,'reported_at',d.reported_at) end,
    'incident',case when i.id is null then null else jsonb_build_object('id',i.id,'outcome',i.outcome,'status',i.status) end,
    'assessment',jsonb_build_object('diagnosis',r.diagnosis,'root_cause',r.root_cause,'preventability',r.preventability,'preventability_label',case r.preventability::text when 'preventable' then 'Можно было предотвратить' when 'partially_preventable' then 'Частично предотвратимо' when 'not_reasonably_preventable' then 'Разумно предотвратить нельзя' else 'Не определено' end,'preventive_action',r.preventive_action),
    'work_summary',jsonb_build_object('completed_count',(select count(*)::int from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null),'total_cost',(select coalesce(sum(w.cost_amount),0) from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null)),
    'work_items',coalesce((select jsonb_agg(jsonb_build_object('id',w.id,'description',w.description,'part_name',w.part_name,'quantity',w.quantity,'cost_amount',w.cost_amount,'completed_at',w.completed_at,'recorded_by',w.recorded_by) order by w.completed_at,w.created_at) from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null),'[]'::jsonb),
    'next_step',case r.status::text
      when 'reported' then jsonb_build_object('title','Начните диагностику','detail','Машина уже выведена из обычного рабочего цикла. Следующий шаг — диагностика неисправности.','action_id','start_diagnostics')
      when 'diagnostics' then case when nullif(btrim(r.diagnosis),'') is null
        then jsonb_build_object('title','Зафиксируйте диагноз','detail','Коротко запишите, что обнаружено. После этого можно начать ремонт или продолжить ожидание запчастей.','action_id','edit_assessment')
        else jsonb_build_object('title','Определите дальнейший ремонт','detail','Диагноз зафиксирован. Начните ремонт либо отметьте ожидание запчастей. Если восстановление невозможно — завершите ремонтную ветку отдельным действием.','action_id','start_repair') end
      when 'waiting_parts' then case when nullif(btrim(r.diagnosis),'') is null
        then jsonb_build_object('title','Зафиксируйте диагноз','detail','Запчасти можно ожидать уже сейчас, но до начала ремонта диагноз должен быть записан.','action_id','edit_assessment')
        else jsonb_build_object('title','Ожидаются запчасти','detail','Когда запчасти поступят, отметьте это — карточка перейдёт к ремонту.','action_id','parts_received') end
      when 'in_repair' then case when not exists(select 1 from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null)
        then jsonb_build_object('title','Запишите выполненную работу','detail','Коротко укажите, что реально сделали. Запчасть и стоимость нужны только если они были.','action_id','record_work')
        else jsonb_build_object('title','Работы записаны','detail','Если ремонт закончен — переведите машину на проверку. Дополнительные работы можно добавить до проверки.','action_id','start_testing') end
      when 'testing' then jsonb_build_object('title','Проверьте результат ремонта','detail','Если проверка успешна, верните машину в эксплуатацию. Если требуется доработка — верните карточку на этап ремонта.','action_id','return_to_service')
      when 'cancelled' then jsonb_build_object('title','Ремонтная ветка завершена','detail','Дальнейшие действия выполняются в связанном происшествии.','action_id','open_incident')
      else jsonb_build_object('title','Ремонт завершён','detail','Дополнительных действий по этому ремонту сейчас не требуется.','action_id','none') end,
    'primary_action',case r.status::text
      when 'reported' then jsonb_build_object('id','start_diagnostics','label','Начать диагностику','enabled',true)
      when 'diagnostics' then case when nullif(btrim(r.diagnosis),'') is null then jsonb_build_object('id','edit_assessment','label','Записать диагноз','enabled',true) else jsonb_build_object('id','start_repair','label','Начать ремонт','enabled',true) end
      when 'waiting_parts' then case when nullif(btrim(r.diagnosis),'') is null then jsonb_build_object('id','edit_assessment','label','Записать диагноз','enabled',true) else jsonb_build_object('id','parts_received','label','Запчасти получены','enabled',true) end
      when 'in_repair' then case when not exists(select 1 from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null) then jsonb_build_object('id','record_work','label','Записать работу','enabled',true) else jsonb_build_object('id','start_testing','label','На проверку','enabled',true) end
      when 'testing' then jsonb_build_object('id','return_to_service','label','Вернуть в строй','enabled',true)
      else jsonb_build_object('id','none','label','Завершено','enabled',false) end,
    'secondary_actions',case r.status::text
      when 'diagnostics' then case when nullif(btrim(r.diagnosis),'') is null then jsonb_build_array(jsonb_build_object('id','wait_parts','label','Нужны запчасти','enabled',true)) else jsonb_build_array(jsonb_build_object('id','wait_parts','label','Нужны запчасти','enabled',true),jsonb_build_object('id','edit_assessment','label','Изменить диагноз','enabled',true)) end
      when 'waiting_parts' then case when nullif(btrim(r.diagnosis),'') is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('id','edit_assessment','label','Изменить диагноз','enabled',true)) end
      when 'in_repair' then jsonb_build_array(jsonb_build_object('id','edit_assessment','label','Причина и профилактика','enabled',true))
      when 'testing' then jsonb_build_array(jsonb_build_object('id','resume_repair','label','Нужна доработка','enabled',true),jsonb_build_object('id','edit_assessment','label','Результат и причина','enabled',true))
      else '[]'::jsonb end,
    'exception_action',case
      when i.id is not null and i.outcome='repairable' and i.status<>'closed' and r.status in ('diagnostics','waiting_parts','in_repair','testing') and nullif(btrim(r.diagnosis),'') is not null
        then jsonb_build_object('id','declare_not_repairable','label','Восстановление невозможно','enabled',true,'incident_id',i.id)
      when r.status='cancelled' and i.id is not null
        then jsonb_build_object('id','open_incident','label','Открыть происшествие','enabled',true,'incident_id',i.id)
      else null end,
    'ux_rules',jsonb_build_object('show_status_dropdown',false,'show_assessment_collapsed',true,'max_primary_actions',1,'max_secondary_actions',2,'show_next_step',true,'preserve_assessment_values',true,'diagnosis_required_before_repair',true,'work_item_required_before_testing',true,'non_repairable_is_exception_action',true)
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

revoke all on function public.record_repair_work_item(uuid,text,text,numeric,numeric) from public,anon;
grant execute on function public.record_repair_work_item(uuid,text,text,numeric,numeric) to authenticated;
revoke all on function public.advance_repair_case(uuid,text) from public,anon;
grant execute on function public.advance_repair_case(uuid,text) to authenticated;
revoke all on function public.get_repair_case_card(uuid) from public,anon;
grant execute on function public.get_repair_case_card(uuid) to authenticated;
