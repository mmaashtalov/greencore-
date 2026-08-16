create or replace function public.set_maintenance_rule_active(p_rule_id uuid,p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare r public.maintenance_rules%rowtype;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Действие доступно только администратору'; end if;
  if p_active is null then raise exception 'Не указано состояние регламента'; end if;
  select * into r from public.maintenance_rules where id=p_rule_id for update;
  if r.id is null then raise exception 'Регламент ТО не найден'; end if;
  if r.is_active=p_active then
    return jsonb_build_object('id',r.id,'is_active',r.is_active,'changed',false);
  end if;
  if p_active and exists(
    select 1 from public.maintenance_rules x
    where x.vehicle_id=r.vehicle_id and x.is_active and x.id<>r.id
      and lower(btrim(x.item_name))=lower(btrim(r.item_name))
  ) then
    raise exception 'Нельзя включить регламент: для этой техники уже есть активный регламент с таким названием';
  end if;
  begin
    update public.maintenance_rules set is_active=p_active where id=r.id;
  exception when unique_violation then
    raise exception 'Нельзя включить регламент: для этой техники уже есть активный регламент с таким названием';
  end;
  return jsonb_build_object('id',r.id,'is_active',p_active,'changed',true);
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
  archived_rule_count integer:=0;
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
  select count(*)::int into archived_rule_count from public.maintenance_rules r where r.vehicle_id=p_vehicle_id and not r.is_active;

  select m.rule_id,m.maintenance_state into target_rule_id,target_state
    from public.v_maintenance_status m
    where m.vehicle_id=p_vehicle_id and m.maintenance_state in ('overdue','no_history','warning')
    order by case m.maintenance_state when 'overdue' then 1 when 'no_history' then 2 when 'warning' then 3 else 4 end,
             coalesce(m.remaining_km,1e18),coalesce(m.remaining_days,2147483647),m.item_name
    limit 1;

  return jsonb_build_object(
    'ui_version','vehicle_maintenance_v4',
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model)||' №'||v.internal_number,'status',v.status),
    'serviceable',serviceable,
    'attention_suspended',open_repair,
    'attention_reason',case when not serviceable then 'Для этой техники плановое ТО больше не ведётся' when open_repair then 'ТО не поднимается отдельной задачей до завершения ремонта' else null end,
    'summary',jsonb_build_object('active_rules',active_rule_count,'archived_rules',archived_rule_count,'no_history',no_history_count,'overdue',overdue_count,'warning',warning_count),
    'rules',coalesce((select jsonb_agg(jsonb_build_object('id',m.rule_id,'item_name',m.item_name,'state',m.maintenance_state,'remaining_km',m.remaining_km,'remaining_days',m.remaining_days,'due_at',m.due_at,'last_service_at',m.last_service_at) order by case m.maintenance_state when 'overdue' then 1 when 'no_history' then 2 when 'warning' then 3 else 4 end,m.item_name) from public.v_maintenance_status m where m.vehicle_id=p_vehicle_id),'[]'::jsonb),
    'archived_rules',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'item_name',r.item_name,'interval_km',r.interval_km,'interval_days',r.interval_days,'notes',r.notes) order by r.item_name) from public.maintenance_rules r where r.vehicle_id=p_vehicle_id and not r.is_active),'[]'::jsonb),
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

revoke all on function public.set_maintenance_rule_active(uuid,boolean) from public,anon;
grant execute on function public.set_maintenance_rule_active(uuid,boolean) to authenticated;
revoke all on function public.get_vehicle_maintenance_ui(uuid) from public,anon;
grant execute on function public.get_vehicle_maintenance_ui(uuid) to authenticated;
