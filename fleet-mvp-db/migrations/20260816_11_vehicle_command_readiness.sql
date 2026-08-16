-- Expose a simple server-side answer to "can this vehicle receive a waybill now?"
-- Readiness mirrors the actual issue-waybill constraints for the default 10-day horizon.

create or replace function public.get_vehicle_command_summary(p_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  v public.vehicles%rowtype;
  assigned record;
  wb record;
  maint record;
  repair record;
  incident record;
  fuel_norm numeric;
  mileage30 numeric:=0;
  fuel30 numeric:=0;
  variance30 numeric:=0;
  eligible_drivers integer:=0;
  readiness_valid_to date:=((now() at time zone 'Europe/Moscow')::date + 10);
  has_active_waybill boolean:=false;
  vehicle_status_label text;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into v from public.vehicles where id=p_vehicle_id;
  if v.id is null then raise exception 'Vehicle not found'; end if;

  vehicle_status_label:=case v.status::text
    when 'operational' then 'В эксплуатации' when 'reserve' then 'Резерв' when 'maintenance' then 'На ТО'
    when 'repair' then 'В ремонте' when 'disabled' then 'Не эксплуатируется' when 'destroyed' then 'Уничтожена'
    when 'written_off' then 'Списана' else v.status::text end;

  select e.id,e.full_name,e.rank_title into assigned
  from public.vehicle_assignments a join public.employees e on e.id=a.driver_id
  where a.vehicle_id=v.id and a.valid_from<=now() and (a.valid_to is null or a.valid_to>now())
  order by a.is_primary desc,a.valid_from desc limit 1;

  select w.id,w.number,w.status,w.valid_from,w.valid_to,e.full_name driver_name into wb
  from public.waybills w join public.employees e on e.id=w.driver_id
  where (w.vehicle_id=v.id or w.trailer_id=v.id) and w.status in ('issued','active','closed_by_driver','under_review','needs_correction')
  order by case w.status when 'active' then 1 when 'issued' then 2 when 'needs_correction' then 3 when 'closed_by_driver' then 4 else 5 end,w.valid_from desc limit 1;

  has_active_waybill:=exists(select 1 from public.waybills w where w.vehicle_id=v.id and w.status in ('issued','active'));

  select r.id,r.status,r.diagnosis,d.description defect_description into repair
  from public.repair_cases r left join public.vehicle_defects d on d.id=r.defect_id
  where r.vehicle_id=v.id and r.status not in ('closed','cancelled')
  order by r.opened_at desc limit 1;

  select i.id,i.status,i.outcome,i.description,i.occurred_at into incident
  from public.vehicle_incidents i where i.vehicle_id=v.id and i.status<>'closed'
  order by i.occurred_at desc limit 1;

  select m.rule_id,m.item_name,m.maintenance_state,m.remaining_km,m.remaining_days,m.due_odometer_km,m.due_at into maint
  from public.v_maintenance_status m
  where m.vehicle_id=v.id
  order by case m.maintenance_state when 'overdue' then 1 when 'warning' then 2 when 'no_history' then 3 else 4 end,
           least(coalesce(m.remaining_km,1e12),coalesce(m.remaining_days::numeric*100,1e12))
  limit 1;

  select n.rate_l_per_100km into fuel_norm from public.vehicle_fuel_norms n
  where n.vehicle_id=v.id and n.valid_to is null order by n.valid_from desc limit 1;

  if v.asset_type='self_propelled' then
    select count(*)::integer into eligible_drivers
    from public.drivers d
    join public.employees e on e.id=d.employee_id
    where e.is_active
      and d.license_valid_to is not null
      and d.license_valid_to>=readiness_valid_to
      and not exists(select 1 from public.waybills w where w.driver_id=e.id and w.status in ('issued','active'))
      and not exists(
        select 1 from public.vehicle_license_requirements r
        where r.vehicle_id=v.id
          and not exists(select 1 from public.driver_license_categories c where c.driver_id=e.id and c.category=r.category)
      );

    select coalesce(sum(c.mileage_km),0),coalesce(sum(c.actual_consumption_l),0),coalesce(sum(c.variance_l),0)
      into mileage30,fuel30,variance30
    from public.waybills w left join public.v_waybill_calculations c on c.waybill_id=w.id
    where w.vehicle_id=v.id and w.status in ('approved','archived')
      and coalesce(w.closed_at,w.valid_to)>=now()-interval '30 days';
  end if;

  return jsonb_build_object(
    'ui_version','vehicle_command_summary_v2',
    'vehicle',jsonb_build_object(
      'id',v.id,'asset_type',v.asset_type,'status_label',vehicle_status_label,
      'odometer_km',case when v.asset_type='self_propelled' then v.current_odometer_km else null end,
      'fuel_l',case when v.asset_type='self_propelled' then v.current_fuel_l else null end,
      'fuel_norm',fuel_norm
    ),
    'readiness',case
      when v.asset_type<>'self_propelled' then jsonb_build_object(
        'applicable',false,'ready',false,'code','trailer','tone','neutral','label','Прицеп','detail','ПЛ оформляется на тягач.'
      )
      when v.status not in ('operational','reserve') then jsonb_build_object(
        'applicable',true,'ready',false,'code','vehicle_unavailable','tone','warning','label','ПЛ недоступен','detail',vehicle_status_label
      )
      when has_active_waybill then jsonb_build_object(
        'applicable',true,'ready',false,'code','active_waybill','tone','info','label','ПЛ уже выдан','detail','Сначала завершите текущий путевой лист.'
      )
      when v.fuel_type_id is not null and fuel_norm is null then jsonb_build_object(
        'applicable',true,'ready',false,'code','fuel_norm','tone','warning','label','Нужна норма топлива','detail','Задайте действующую норму перед выдачей ПЛ.',
        'action',jsonb_build_object('id','fuel_norm','label','Настроить норму')
      )
      when eligible_drivers=0 then jsonb_build_object(
        'applicable',true,'ready',false,'code','driver','tone','warning','label','Нет доступного водителя',
        'detail','Нужен свободный водитель с подходящей категорией и ВУ минимум до '||to_char(readiness_valid_to,'DD.MM.YYYY')||'.',
        'action',jsonb_build_object('id','drivers','label','Проверить водителей')
      )
      else jsonb_build_object(
        'applicable',true,'ready',true,'code','ready','tone','success','label','Готова к ПЛ',
        'detail','Доступно водителей: '||eligible_drivers::text||'. Проверка рассчитана на стандартный ПЛ до '||to_char(readiness_valid_to,'DD.MM.YYYY')||'.',
        'eligible_drivers',eligible_drivers,
        'valid_through',readiness_valid_to
      ) end,
    'driver',case when assigned.id is null then null else jsonb_build_object('id',assigned.id,'name',assigned.full_name,'rank',assigned.rank_title) end,
    'waybill',case when wb.id is null then null else jsonb_build_object(
      'id',wb.id,'number',wb.number,'driver',wb.driver_name,'valid_from',wb.valid_from,'valid_to',wb.valid_to,
      'status_label',case wb.status::text when 'issued' then 'Выдан' when 'active' then 'В работе' when 'closed_by_driver' then 'Ждёт проверки' when 'under_review' then 'Проверяется' when 'needs_correction' then 'Нужно исправить' else wb.status::text end
    ) end,
    'service',case
      when repair.id is not null then jsonb_build_object(
        'kind','repair','id',repair.id,'tone','warning',
        'label',case repair.status::text when 'reported' then 'Нужна диагностика' when 'diagnostics' then 'Диагностика' when 'waiting_parts' then 'Ожидает запчасти' when 'in_repair' then 'В ремонте' when 'testing' then 'Проверка после ремонта' else 'Ремонт' end,
        'detail',coalesce(repair.diagnosis,repair.defect_description)
      )
      when incident.id is not null and incident.outcome='unknown' then jsonb_build_object('kind','incident','id',incident.id,'tone','danger','label','Происшествие требует решения','detail',incident.description)
      when maint.rule_id is not null then jsonb_build_object(
        'kind','maintenance','id',maint.rule_id,
        'tone',case maint.maintenance_state when 'overdue' then 'danger' when 'warning' then 'warning' when 'no_history' then 'warning' else 'success' end,
        'label',case maint.maintenance_state when 'overdue' then 'ТО просрочено' when 'warning' then 'Скоро ТО' when 'no_history' then 'Нет исходной записи ТО' else 'ТО по плану' end,
        'detail',case when maint.maintenance_state='no_history' then maint.item_name||' · нужна исходная точка'
                      when maint.remaining_km is not null then maint.item_name||' · '||round(maint.remaining_km)::text||' км'
                      when maint.remaining_days is not null then maint.item_name||' · '||maint.remaining_days::text||' дн.'
                      else maint.item_name end
      )
      else null end,
    'last_30_days',jsonb_build_object('mileage_km',mileage30,'fuel_l',fuel30,'variance_l',variance30),
    'actions',jsonb_strip_nulls(jsonb_build_object(
      'driver',case
        when assigned.id is not null then jsonb_build_object('id','open_driver','target_id',assigned.id,'label','Водитель')
        when v.asset_type='self_propelled' and v.status not in ('destroyed','written_off') then jsonb_build_object('id','assign_driver','target_id',v.id,'label','Закрепить водителя')
        else null end,
      'waybill',case when wb.id is null then null else jsonb_build_object('id','open_waybill','target_id',wb.id,'label','Путевой лист') end,
      'service',case when repair.id is not null then jsonb_build_object('id','open_repair','target_id',repair.id,'label','Ремонт')
                     when incident.id is not null and incident.outcome='unknown' then jsonb_build_object('id','open_incident','target_id',incident.id,'label','Происшествие')
                     when maint.rule_id is not null then jsonb_build_object('id','open_maintenance','target_id',maint.rule_id,'label','ТО') else null end
    )),
    'ux_rules',jsonb_build_object(
      'show_raw_codes',false,'max_cells',4,'service_priority','repair_incident_maintenance',
      'show_waybill_readiness',true,'readiness_horizon_days',10,'assignment_is_optional_for_issue',true
    )
  );
end;
$function$;
