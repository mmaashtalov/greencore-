create or replace function public.complete_maintenance(p_rule_id uuid, p_odometer_km numeric, p_performed_at timestamptz, p_description text, p_cost_amount numeric)
returns uuid
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare
  r public.maintenance_rules%rowtype;
  v public.vehicles%rowtype;
  new_id uuid;
  ts timestamptz;
  has_history boolean:=false;
  last_ts timestamptz;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.maintenance_rules where id=p_rule_id and is_active for update;
  if r.id is null then raise exception 'Maintenance rule not found or inactive'; end if;
  select * into v from public.vehicles where id=r.vehicle_id for update;
  if v.id is null then raise exception 'Vehicle not found'; end if;
  if p_odometer_km is null or p_odometer_km<0 then raise exception 'Odometer is required'; end if;
  if p_cost_amount is not null and p_cost_amount<0 then raise exception 'Cost cannot be negative'; end if;

  select exists(select 1 from public.maintenance_events e where e.maintenance_rule_id=r.id and e.status='completed'),
         max(e.performed_at) filter(where e.status='completed')
    into has_history,last_ts
    from public.maintenance_events e where e.maintenance_rule_id=r.id;

  if not has_history and p_performed_at is null then
    raise exception 'Baseline maintenance date is required';
  end if;
  ts:=coalesce(p_performed_at,now());
  if ts>now()+interval '5 minutes' then raise exception 'Maintenance date cannot be in the future'; end if;

  if not has_history then
    if v.current_odometer_km is not null and p_odometer_km>v.current_odometer_km then
      raise exception 'Baseline odometer cannot exceed current vehicle odometer';
    end if;
  else
    if v.current_odometer_km is not null and p_odometer_km < v.current_odometer_km - 100 then
      raise exception 'Odometer is too far below current vehicle odometer';
    end if;
    if last_ts is not null and ts<last_ts then
      raise exception 'Maintenance date cannot be earlier than the latest recorded service';
    end if;
  end if;

  if exists(select 1 from public.maintenance_events e where e.maintenance_rule_id=r.id and e.status='completed' and e.odometer_km=p_odometer_km and abs(extract(epoch from (e.performed_at-ts)))<3600) then
    raise exception 'This maintenance event is already recorded';
  end if;

  insert into public.maintenance_events(vehicle_id,maintenance_rule_id,status,performed_at,odometer_km,description,cost_amount,notes)
  values(r.vehicle_id,r.id,'completed',ts,p_odometer_km,coalesce(nullif(btrim(p_description),''),r.item_name),p_cost_amount,
         case when not has_history then 'Исходная запись ТО' else null end)
  returning id into new_id;

  if has_history and p_odometer_km>coalesce(v.current_odometer_km,0) then
    update public.vehicles set current_odometer_km=p_odometer_km where id=v.id;
  end if;
  if v.status='maintenance' and not exists(select 1 from public.repair_cases rc where rc.vehicle_id=v.id and rc.status not in ('closed','cancelled')) then
    update public.vehicles set status='operational' where id=v.id;
  end if;
  return new_id;
end
$function$;

create or replace function public.get_maintenance_card(p_rule_id uuid)
returns jsonb
language plpgsql
set search_path to 'pg_catalog','public','private'
as $function$
declare result jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select jsonb_build_object(
    'ui_version','maintenance_card_v4','rule_id',m.rule_id,
    'entry_mode',case when m.maintenance_state='no_history' then 'baseline' else 'completion' end,
    'vehicle',jsonb_build_object('id',m.vehicle_id,'label',concat_ws(' ',m.make,m.model),'number',m.internal_number),
    'title',m.item_name,
    'status_label',case m.maintenance_state when 'overdue' then 'Просрочено' when 'warning' then 'Скоро ТО' when 'ok' then 'По плану' when 'no_history' then 'Нет исходной записи ТО' else m.maintenance_state end,
    'tone',case m.maintenance_state when 'overdue' then 'danger' when 'warning' then 'warning' when 'no_history' then 'warning' else 'success' end,
    'current',jsonb_build_object('odometer_km',m.current_odometer_km),
    'last_service',case when m.last_service_at is null and m.last_service_odometer_km is null then null else jsonb_build_object('performed_at',m.last_service_at,'odometer_km',m.last_service_odometer_km) end,
    'next_due',jsonb_build_object('odometer_km',m.due_odometer_km,'date',m.due_at,'remaining_km',m.remaining_km,'remaining_days',m.remaining_days),
    'rule',(select jsonb_build_object('item_name',r.item_name,'interval_km',r.interval_km,'interval_days',r.interval_days,'warning_km',r.warning_km,'warning_days',r.warning_days,'notes',r.notes,'is_active',r.is_active) from public.maintenance_rules r where r.id=m.rule_id),
    'primary_action',case when m.maintenance_state='no_history' then jsonb_build_object('id','complete_maintenance','label','Зафиксировать исходное ТО','enabled',true) when m.maintenance_state in ('warning','overdue') then jsonb_build_object('id','complete_maintenance','label','Отметить ТО выполненным','enabled',true) else jsonb_build_object('id','none','label','ТО по плану','enabled',false) end,
    'secondary_actions',jsonb_build_array(jsonb_build_object('id','edit_rule','label','Настроить регламент','enabled',true)),
    'form',case when m.maintenance_state in ('warning','overdue','no_history') then jsonb_build_object(
      'title',case when m.maintenance_state='no_history' then 'Исходное ТО' else 'ТО выполнено' end,
      'description',case when m.maintenance_state='no_history' then 'Введите фактические дату и пробег последнего подтверждённого обслуживания. Система начнёт считать следующий срок от этой точки.' else 'Запишите фактические дату и пробег уже выполненного обслуживания.' end,
      'fields',jsonb_build_array(
        jsonb_build_object('id','odometer_km','label',case when m.maintenance_state='no_history' then 'Пробег на момент ТО' else 'Пробег' end,'required',true,'default',case when m.maintenance_state='no_history' then null else m.current_odometer_km end,'max',case when m.maintenance_state='no_history' then m.current_odometer_km else null end),
        jsonb_build_object('id','performed_at','label',case when m.maintenance_state='no_history' then 'Когда было выполнено ТО' else 'Дата и время' end,'required',true,'default',case when m.maintenance_state='no_history' then null else 'now' end,'max','now'),
        jsonb_build_object('id','description','label','Что сделано','required',false,'default',m.item_name),
        jsonb_build_object('id','cost_amount','label','Стоимость','required',false)
      ),
      'submit_label',case when m.maintenance_state='no_history' then 'Сохранить исходное ТО' else 'Сохранить ТО' end
    ) else null end,
    'history',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'performed_at',e.performed_at,'odometer_km',e.odometer_km,'description',e.description,'cost_amount',e.cost_amount,'notes',e.notes) order by e.performed_at desc) from (select * from public.maintenance_events e where e.maintenance_rule_id=m.rule_id and e.status='completed' order by e.performed_at desc limit 5) e),'[]'::jsonb),
    'ux_rules',jsonb_build_object('show_rule_intervals_by_default',true,'show_history_limit',5,'one_primary_action',true,'no_history_requires_baseline',true,'baseline_never_defaults_to_current_fact',true)
  ) into result from public.v_maintenance_status m where m.rule_id=p_rule_id;
  if result is null then raise exception 'Maintenance rule not found'; end if;
  return result;
end
$function$;

create or replace function public.get_vehicle_maintenance_ui(p_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  v public.vehicles%rowtype;
  open_repair boolean:=false;
  serviceable boolean:=true;
  active_rule_count integer:=0;
  no_history_count integer:=0;
  overdue_count integer:=0;
  warning_count integer:=0;
  target_rule_id uuid;
  target_state text;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into v from public.vehicles where id=p_vehicle_id;
  if v.id is null or v.asset_type<>'self_propelled' then raise exception 'Vehicle not found'; end if;
  open_repair:=exists(select 1 from public.repair_cases r where r.vehicle_id=v.id and r.status not in ('closed','cancelled'));
  serviceable:=v.status not in ('destroyed','written_off','disabled');

  select count(*)::int,
         count(*) filter(where m.maintenance_state='no_history')::int,
         count(*) filter(where m.maintenance_state='overdue')::int,
         count(*) filter(where m.maintenance_state='warning')::int
    into active_rule_count,no_history_count,overdue_count,warning_count
    from public.v_maintenance_status m where m.vehicle_id=p_vehicle_id;

  select m.rule_id,m.maintenance_state into target_rule_id,target_state
    from public.v_maintenance_status m
    where m.vehicle_id=p_vehicle_id and m.maintenance_state in ('overdue','no_history','warning')
    order by case m.maintenance_state when 'overdue' then 1 when 'no_history' then 2 when 'warning' then 3 else 4 end,
             coalesce(m.remaining_km,1e18),coalesce(m.remaining_days,2147483647),m.item_name
    limit 1;

  return jsonb_build_object(
    'ui_version','vehicle_maintenance_v3',
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model)||' №'||v.internal_number,'status',v.status),
    'serviceable',serviceable,
    'attention_suspended',open_repair,
    'attention_reason',case when not serviceable then 'Для этой техники плановое ТО больше не ведётся' when open_repair then 'ТО не поднимается отдельной задачей до завершения ремонта' else null end,
    'summary',jsonb_build_object('active_rules',active_rule_count,'no_history',no_history_count,'overdue',overdue_count,'warning',warning_count),
    'rules',coalesce((select jsonb_agg(jsonb_build_object('id',m.rule_id,'item_name',m.item_name,'state',m.maintenance_state,'remaining_km',m.remaining_km,'remaining_days',m.remaining_days,'due_at',m.due_at,'last_service_at',m.last_service_at) order by case m.maintenance_state when 'overdue' then 1 when 'no_history' then 2 when 'warning' then 3 else 4 end,m.item_name) from public.v_maintenance_status m where m.vehicle_id=p_vehicle_id),'[]'::jsonb),
    'needs_setup',serviceable and active_rule_count=0,
    'primary_action',case
      when not serviceable then jsonb_build_object('id','none','label','ТО не ведётся','enabled',false)
      when open_repair then jsonb_build_object('id','none','label','ТО проверим после ремонта','enabled',false)
      when active_rule_count=0 then jsonb_build_object('id','create_rule','label','Настроить ТО','enabled',true)
      when target_state='overdue' then jsonb_build_object('id','open_rule','label','Открыть просроченное ТО','enabled',true,'target_rule_id',target_rule_id)
      when target_state='no_history' then jsonb_build_object('id','open_rule','label','Зафиксировать исходное ТО','enabled',true,'target_rule_id',target_rule_id)
      when target_state='warning' then jsonb_build_object('id','open_rule','label','Проверить ближайшее ТО','enabled',true,'target_rule_id',target_rule_id)
      else jsonb_build_object('id','open_rules','label','Открыть регламенты','enabled',true)
    end
  );
end
$function$;

revoke all on function public.get_vehicle_maintenance_ui(uuid) from public,anon;
grant execute on function public.get_vehicle_maintenance_ui(uuid) to authenticated;
revoke all on function public.get_maintenance_card(uuid) from public,anon;
grant execute on function public.get_maintenance_card(uuid) to authenticated;
revoke all on function public.complete_maintenance(uuid,numeric,timestamptz,text,numeric) from public,anon;
grant execute on function public.complete_maintenance(uuid,numeric,timestamptz,text,numeric) to authenticated;
