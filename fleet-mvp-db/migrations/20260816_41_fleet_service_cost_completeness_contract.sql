create or replace function public.get_fleet_service_cost_completeness()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  v_maintenance_completed integer:=0;
  v_maintenance_priced integer:=0;
  v_maintenance_missing integer:=0;
  v_maintenance_cost numeric:=0;
  v_closed_repairs integer:=0;
  v_closed_without_work integer:=0;
  v_completed_work integer:=0;
  v_priced_work integer:=0;
  v_unpriced_work integer:=0;
  v_repair_cost numeric:=0;
  v_active_repairs_without_work integer:=0;
  v_history_vehicles integer:=0;
  v_complete_history_vehicles integer:=0;
  v_status text;
  v_label text;
  v_note text;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;

  select
    count(*) filter (where e.status='completed')::integer,
    count(*) filter (where e.status='completed' and e.cost_amount is not null)::integer,
    count(*) filter (where e.status='completed' and e.cost_amount is null)::integer,
    coalesce(sum(e.cost_amount) filter (where e.status='completed' and e.cost_amount is not null),0)
  into v_maintenance_completed,v_maintenance_priced,v_maintenance_missing,v_maintenance_cost
  from public.maintenance_events e;

  select
    count(*) filter (where r.status='closed')::integer,
    count(*) filter (
      where r.status='closed'
        and not exists (
          select 1 from public.repair_work_items w
          where w.repair_case_id=r.id and w.completed_at is not null
        )
    )::integer,
    count(*) filter (
      where r.status in ('in_repair','testing')
        and not exists (
          select 1 from public.repair_work_items w
          where w.repair_case_id=r.id and w.completed_at is not null
        )
    )::integer
  into v_closed_repairs,v_closed_without_work,v_active_repairs_without_work
  from public.repair_cases r;

  select
    count(w.id) filter (where w.completed_at is not null)::integer,
    count(w.id) filter (where w.completed_at is not null and w.cost_amount is not null)::integer,
    count(w.id) filter (where w.completed_at is not null and w.cost_amount is null)::integer,
    coalesce(sum(w.cost_amount) filter (where w.completed_at is not null and w.cost_amount is not null),0)
  into v_completed_work,v_priced_work,v_unpriced_work,v_repair_cost
  from public.repair_work_items w;

  with history_vehicles as (
    select e.vehicle_id
      from public.maintenance_events e
     where e.status='completed'
    union
    select r.vehicle_id
      from public.repair_cases r
     where r.status='closed'
  ), completeness as (
    select hv.vehicle_id,
      not exists (
        select 1 from public.maintenance_events e
         where e.vehicle_id=hv.vehicle_id and e.status='completed' and e.cost_amount is null
      )
      and not exists (
        select 1 from public.repair_cases r
         where r.vehicle_id=hv.vehicle_id and r.status='closed'
           and not exists (
             select 1 from public.repair_work_items w
              where w.repair_case_id=r.id and w.completed_at is not null
           )
      )
      and not exists (
        select 1
          from public.repair_cases r
          join public.repair_work_items w on w.repair_case_id=r.id
         where r.vehicle_id=hv.vehicle_id and r.status='closed'
           and w.completed_at is not null and w.cost_amount is null
      ) as complete
    from history_vehicles hv
  )
  select count(*)::integer,
         count(*) filter (where complete)::integer
    into v_history_vehicles,v_complete_history_vehicles
    from completeness;

  if v_history_vehicles=0 then
    v_status:='no_history';
    v_label:='Сервисная история ещё не накоплена';
    v_note:='Показатель полноты появится после первого завершённого ТО или закрытого ремонта.';
  elsif v_complete_history_vehicles=v_history_vehicles then
    v_status:='complete';
    v_label:='Стоимость сервисной истории заполнена';
    v_note:='Для завершённых ТО и закрытых ремонтов нет известных пробелов в стоимости.';
  else
    v_status:='needs_data';
    v_label:='Стоимость сервисной истории заполнена не полностью';
    v_note:='Пустая стоимость означает неизвестную сумму и не считается нулевыми затратами.';
  end if;

  return jsonb_build_object(
    'ui_version','fleet_service_cost_completeness_v1',
    'summary',jsonb_build_object(
      'maintenance_completed',v_maintenance_completed,
      'maintenance_priced',v_maintenance_priced,
      'maintenance_missing_cost',v_maintenance_missing,
      'closed_repairs',v_closed_repairs,
      'closed_repairs_without_work_log',v_closed_without_work,
      'completed_repair_work_items',v_completed_work,
      'priced_repair_work_items',v_priced_work,
      'unpriced_repair_work_items',v_unpriced_work,
      'active_repairs_without_work_log',v_active_repairs_without_work,
      'recorded_maintenance_cost',v_maintenance_cost,
      'recorded_repair_cost',v_repair_cost,
      'recorded_service_cost',v_maintenance_cost+v_repair_cost,
      'history_vehicle_count',v_history_vehicles,
      'complete_history_vehicle_count',v_complete_history_vehicles,
      'incomplete_history_vehicle_count',greatest(v_history_vehicles-v_complete_history_vehicles,0),
      'actionable_issue_count',v_maintenance_missing + (
        select count(*)::integer
          from public.repair_work_items w
          join public.repair_cases r on r.id=w.repair_case_id
         where w.completed_at is not null and w.cost_amount is null
           and r.status in ('in_repair','testing')
      ) + v_active_repairs_without_work,
      'historical_gap_count',v_closed_without_work + (
        select count(*)::integer
          from public.repair_work_items w
          join public.repair_cases r on r.id=w.repair_case_id
         where w.completed_at is not null and w.cost_amount is null
           and r.status in ('closed','cancelled')
      )
    ),
    'completeness',jsonb_build_object(
      'status',v_status,
      'label',v_label,
      'note',v_note
    ),
    'issues',coalesce((
      select jsonb_agg(q.payload order by q.priority,q.sort_at desc nulls last)
      from (
        select 10 priority,e.performed_at sort_at,
          jsonb_build_object(
            'kind','maintenance_cost_missing',
            'severity','warning',
            'label','ТО без стоимости',
            'detail',concat_ws(' · ',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,'')),mr.item_name,to_char(e.performed_at at time zone 'Europe/Helsinki','DD.MM.YYYY')),
            'vehicle_id',v.id,
            'maintenance_rule_id',mr.id,
            'event_id',e.id,
            'performed_at',e.performed_at,
            'odometer_km',e.odometer_km,
            'action',jsonb_build_object('type','maintenance','target_id',mr.id,'label','Исправить запись')
          ) payload
        from public.maintenance_events e
        join public.maintenance_rules mr on mr.id=e.maintenance_rule_id
        join public.vehicles v on v.id=e.vehicle_id
        where e.status='completed' and e.cost_amount is null

        union all

        select 20 priority,w.completed_at sort_at,
          jsonb_build_object(
            'kind','repair_work_cost_missing',
            'severity',case when r.status in ('in_repair','testing') then 'warning' else 'danger' end,
            'label','Работа без стоимости',
            'detail',concat_ws(' · ',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,'')),w.description),
            'vehicle_id',v.id,
            'repair_id',r.id,
            'work_item_id',w.id,
            'performed_at',w.completed_at,
            'action',jsonb_build_object('type','repair','target_id',r.id,'label',case when r.status in ('in_repair','testing') then 'Открыть ремонт' else 'Открыть историю' end),
            'historical_gap',(r.status in ('closed','cancelled'))
          ) payload
        from public.repair_work_items w
        join public.repair_cases r on r.id=w.repair_case_id
        join public.vehicles v on v.id=r.vehicle_id
        where w.completed_at is not null and w.cost_amount is null

        union all

        select 30 priority,r.opened_at sort_at,
          jsonb_build_object(
            'kind','active_repair_without_work_log',
            'severity','warning',
            'label','Ремонт без журнала работ',
            'detail',concat_ws(' · ',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,'')),'работы ещё не записаны'),
            'vehicle_id',v.id,
            'repair_id',r.id,
            'performed_at',r.opened_at,
            'action',jsonb_build_object('type','repair','target_id',r.id,'label','Записать работы')
          ) payload
        from public.repair_cases r
        join public.vehicles v on v.id=r.vehicle_id
        where r.status in ('in_repair','testing')
          and not exists (
            select 1 from public.repair_work_items w
             where w.repair_case_id=r.id and w.completed_at is not null
          )

        union all

        select 40 priority,r.closed_at sort_at,
          jsonb_build_object(
            'kind','closed_repair_without_work_log',
            'severity','danger',
            'label','Закрытый ремонт без журнала работ',
            'detail',concat_ws(' · ',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,'')),'историческая стоимость не подтверждена'),
            'vehicle_id',v.id,
            'repair_id',r.id,
            'performed_at',r.closed_at,
            'historical_gap',true,
            'action',jsonb_build_object('type','repair','target_id',r.id,'label','Открыть историю')
          ) payload
        from public.repair_cases r
        join public.vehicles v on v.id=r.vehicle_id
        where r.status='closed'
          and not exists (
            select 1 from public.repair_work_items w
             where w.repair_case_id=r.id and w.completed_at is not null
          )
      ) q
    ),'[]'::jsonb),
    'ux_rules',jsonb_build_object(
      'null_cost_means_unknown',true,
      'explicit_zero_cost_is_valid',true,
      'diagnostics_without_work_is_not_an_issue',true,
      'vehicles_without_service_history_are_excluded_from_completeness',true,
      'max_home_issue_rows',7
    )
  );
end;
$function$;

revoke all on function public.get_fleet_service_cost_completeness() from public;
revoke all on function public.get_fleet_service_cost_completeness() from anon;
grant execute on function public.get_fleet_service_cost_completeness() to authenticated;
