create index if not exists waybills_vehicle_closed_at_idx
  on public.waybills(vehicle_id,closed_at);

create index if not exists maintenance_events_vehicle_performed_at_idx
  on public.maintenance_events(vehicle_id,performed_at);

create index if not exists repair_cases_vehicle_closed_at_idx
  on public.repair_cases(vehicle_id,closed_at);

create index if not exists repair_work_items_case_completed_at_idx
  on public.repair_work_items(repair_case_id,completed_at);

create or replace function public.get_vehicle_operating_period_summary(
  p_vehicle_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  v public.vehicles%rowtype;
  v_all boolean:=false;
  v_final_waybills integer:=0;
  v_mileage_waybills integer:=0;
  v_fuel_waybills integer:=0;
  v_mileage numeric:=0;
  v_received numeric:=0;
  v_consumed numeric:=0;
  v_normative numeric:=0;
  v_variance numeric:=0;
  v_refuels integer:=0;
  v_avg_l100 numeric;
  v_fuel_tx_count integer:=0;
  v_fuel_priced integer:=0;
  v_fuel_cost numeric:=0;
  v_maint_count integer:=0;
  v_maint_priced integer:=0;
  v_maint_cost numeric:=0;
  v_repair_count integer:=0;
  v_closed_repairs integer:=0;
  v_closed_without_work integer:=0;
  v_work_count integer:=0;
  v_work_priced integer:=0;
  v_repair_cost numeric:=0;
  v_service_cost numeric:=0;
  v_known_cost numeric:=0;
  v_known_cost_available boolean:=false;
  v_known_cost_complete boolean:=false;
  v_known_cost_per_1000 numeric;
  v_service_complete boolean:=true;
  v_trip_complete boolean:=true;
  v_fuel_money_complete boolean:=true;
  v_money_records integer:=0;
  v_priced_records integer:=0;
  v_missing_amount_records integer:=0;
  v_status text;
  v_label text;
  v_note text;
  v_scope_label text;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;
  if (p_from is null) <> (p_to is null) then
    raise exception 'Period boundaries must both be set or both be empty';
  end if;
  if p_from is not null and p_to<=p_from then
    raise exception 'Period end must be after period start';
  end if;
  v_all:=p_from is null and p_to is null;
  select * into v from public.vehicles where id=p_vehicle_id;
  if v.id is null then raise exception 'Vehicle not found'; end if;

  select count(*)::integer,
         count(*) filter (where c.mileage_km is not null and c.mileage_km>=0)::integer,
         count(*) filter (where c.mileage_km is not null and c.mileage_km>0 and c.actual_consumption_l is not null and c.actual_consumption_l>=0)::integer,
         coalesce(sum(c.mileage_km) filter (where c.mileage_km is not null and c.mileage_km>=0),0),
         coalesce(sum(c.fuel_received_l),0),
         coalesce(sum(c.actual_consumption_l) filter (where c.actual_consumption_l is not null and c.actual_consumption_l>=0),0),
         coalesce(sum(c.normative_consumption_l) filter (where c.normative_consumption_l is not null),0),
         coalesce(sum(c.variance_l) filter (where c.variance_l is not null),0),
         coalesce(sum(c.refuel_count),0)::integer
    into v_final_waybills,v_mileage_waybills,v_fuel_waybills,v_mileage,v_received,v_consumed,v_normative,v_variance,v_refuels
  from public.v_waybill_calculations c
  join public.waybills wb on wb.id=c.waybill_id
  where c.vehicle_id=v.id
    and c.status::text in ('approved','archived','closed_by_incident')
    and (v_all or (wb.closed_at>=p_from and wb.closed_at<p_to));

  select count(ft.id)::integer,
         count(ft.id) filter (where ft.cost_amount is not null)::integer,
         coalesce(sum(ft.cost_amount) filter (where ft.cost_amount is not null),0)
    into v_fuel_tx_count,v_fuel_priced,v_fuel_cost
  from public.fuel_transactions ft
  join public.waybills wb on wb.id=ft.waybill_id
  where ft.vehicle_id=v.id
    and wb.status::text in ('approved','archived','closed_by_incident')
    and (v_all or (wb.closed_at>=p_from and wb.closed_at<p_to));

  select count(*)::integer,
         count(*) filter (where me.cost_amount is not null)::integer,
         coalesce(sum(me.cost_amount) filter (where me.cost_amount is not null),0)
    into v_maint_count,v_maint_priced,v_maint_cost
  from public.maintenance_events me
  where me.vehicle_id=v.id and me.status::text='completed'
    and (v_all or (me.performed_at>=p_from and me.performed_at<p_to));

  select count(*)::integer into v_repair_count
  from public.repair_cases r
  where r.vehicle_id=v.id
    and (v_all
      or (r.opened_at>=p_from and r.opened_at<p_to)
      or (r.closed_at>=p_from and r.closed_at<p_to)
      or exists(select 1 from public.repair_work_items wi
                where wi.repair_case_id=r.id and wi.completed_at is not null
                  and wi.completed_at>=p_from and wi.completed_at<p_to));

  select count(*)::integer into v_closed_repairs
  from public.repair_cases r
  where r.vehicle_id=v.id and r.status::text='closed'
    and (v_all or (r.closed_at>=p_from and r.closed_at<p_to));

  select count(*)::integer into v_closed_without_work
  from public.repair_cases r
  where r.vehicle_id=v.id and r.status::text='closed'
    and (v_all or (r.closed_at>=p_from and r.closed_at<p_to))
    and not exists(select 1 from public.repair_work_items wi
                   where wi.repair_case_id=r.id and wi.completed_at is not null);

  select count(wi.id)::integer,
         count(wi.id) filter (where wi.cost_amount is not null)::integer,
         coalesce(sum(wi.cost_amount) filter (where wi.cost_amount is not null),0)
    into v_work_count,v_work_priced,v_repair_cost
  from public.repair_cases r
  join public.repair_work_items wi on wi.repair_case_id=r.id and wi.completed_at is not null
  where r.vehicle_id=v.id
    and (v_all or (wi.completed_at>=p_from and wi.completed_at<p_to));

  v_service_cost:=coalesce(v_maint_cost,0)+coalesce(v_repair_cost,0);
  v_known_cost:=coalesce(v_fuel_cost,0)+v_service_cost;
  v_money_records:=v_fuel_tx_count+v_maint_count+v_work_count;
  v_priced_records:=v_fuel_priced+v_maint_priced+v_work_priced;
  v_missing_amount_records:=greatest(v_money_records-v_priced_records,0);
  v_known_cost_available:=v_priced_records>0;
  v_service_complete:=(v_maint_priced=v_maint_count) and (v_work_priced=v_work_count) and v_closed_without_work=0;
  v_trip_complete:=v_final_waybills=0 or (v_mileage_waybills=v_final_waybills and v_fuel_waybills=v_final_waybills);
  v_fuel_money_complete:=v_fuel_tx_count=0 or v_fuel_priced=v_fuel_tx_count;
  v_known_cost_complete:=v_known_cost_available and v_fuel_money_complete and v_service_complete;

  if v_mileage>0 and v_fuel_waybills>0 then
    v_avg_l100:=round((v_consumed*100/nullif(v_mileage,0))::numeric,2);
  end if;
  if v_known_cost_available and v_mileage>0 then
    v_known_cost_per_1000:=round((v_known_cost*1000/nullif(v_mileage,0))::numeric,2);
  end if;

  if v_final_waybills=0 and v_maint_count=0 and v_repair_count=0 and v_work_count=0 then
    v_status:='no_history'; v_label:='В выбранном периоде данных нет'; v_note:='Измените период или выберите всю историю.';
  elsif not v_trip_complete or not v_service_complete or not v_fuel_money_complete then
    v_status:='partial'; v_label:='Данные за период заполнены частично'; v_note:='Показаны только подтверждённые значения. Неизвестные суммы не заменяются нулём.';
  else
    v_status:='recorded_complete'; v_label:='Записанные данные за период согласованы'; v_note:='Все существующие записи движения, заправок и сервиса в выбранном срезе имеют достаточные исходные данные.';
  end if;
  v_scope_label:=case when v_all then 'За всю записанную историю' else 'За выбранный период' end;

  return jsonb_build_object(
    'ui_version','vehicle_operating_period_summary_v1',
    'scope',jsonb_build_object(
      'kind',case when v_all then 'all_recorded_history' else 'selected_period' end,
      'label',v_scope_label,'from',p_from,'to_exclusive',p_to,
      'movement_basis','waybill_closed_at','fuel_basis','waybill_closed_at',
      'maintenance_basis','performed_at','repair_basis','work_completed_at',
      'basis_note','Пробег, расход топлива и заправки относятся к периоду по дате закрытия ПЛ. ТО — по дате выполнения. Ремонтные затраты — по дате выполнения работы.'),
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,''))),
    'movement',jsonb_build_object('finalized_waybills',v_final_waybills,'mileage_complete_waybills',v_mileage_waybills,'confirmed_mileage_km',v_mileage,'complete',v_trip_complete),
    'fuel',jsonb_build_object(
      'balance_complete_waybills',v_fuel_waybills,'refuel_count',v_refuels,'received_l',v_received,
      'actual_consumption_l',v_consumed,'normative_consumption_l',v_normative,'variance_l',v_variance,
      'average_l_per_100km',v_avg_l100,'complete',(v_final_waybills=0 or v_fuel_waybills=v_final_waybills),
      'cost_transactions',v_fuel_tx_count,'priced_transactions',v_fuel_priced,
      'missing_cost_transactions',greatest(v_fuel_tx_count-v_fuel_priced,0),
      'recorded_cost',case when v_fuel_priced>0 then v_fuel_cost else null end,
      'monetary_cost_available',(v_fuel_priced>0),'monetary_cost_complete',v_fuel_money_complete,
      'monetary_cost_note',case when v_fuel_tx_count=0 then 'Заправок по ПЛ, закрытым в выбранном периоде, нет.' when v_fuel_money_complete then 'Стоимость указана для всех заправок в выбранном срезе.' else 'Часть заправок не имеет стоимости. Пустая сумма не считается нулём.' end),
    'service',jsonb_build_object(
      'maintenance_completed',v_maint_count,'maintenance_priced',v_maint_priced,'maintenance_missing_cost',greatest(v_maint_count-v_maint_priced,0),
      'maintenance_recorded_cost',case when v_maint_priced>0 then v_maint_cost else null end,
      'repair_count',v_repair_count,'closed_repair_count',v_closed_repairs,'closed_repairs_without_work_log',v_closed_without_work,
      'repair_work_items',v_work_count,'repair_priced_work_items',v_work_priced,'repair_unpriced_work_items',greatest(v_work_count-v_work_priced,0),
      'repair_recorded_cost',case when v_work_priced>0 then v_repair_cost else null end,
      'recorded_service_cost',case when (v_maint_priced+v_work_priced)>0 then v_service_cost else null end,
      'cost_available',((v_maint_priced+v_work_priced)>0),'complete',v_service_complete),
    'money',jsonb_build_object(
      'recorded_known_cost',case when v_known_cost_available then v_known_cost else null end,
      'recorded_known_cost_available',v_known_cost_available,'recorded_known_cost_complete',v_known_cost_complete,
      'recorded_known_cost_per_1000km',v_known_cost_per_1000,
      'fuel_recorded_cost',case when v_fuel_priced>0 then v_fuel_cost else null end,
      'maintenance_recorded_cost',case when v_maint_priced>0 then v_maint_cost else null end,
      'repair_recorded_cost',case when v_work_priced>0 then v_repair_cost else null end,
      'monetary_records',v_money_records,'priced_records',v_priced_records,'missing_amount_records',v_missing_amount_records),
    'completeness',jsonb_build_object(
      'status',v_status,'label',v_label,'note',v_note,'trip_data_complete',v_trip_complete,
      'fuel_cost_complete',v_fuel_money_complete,'service_cost_complete',v_service_complete,'known_cost_complete',v_known_cost_complete),
    'cost_model',jsonb_build_object(
      'total_operating_cost_supported',false,'recorded_direct_cost_supported',true,
      'reason','Это записанные прямые расходы, а не полная стоимость владения: стоимость топлива в начальных остатках, амортизация, страхование и другие косвенные расходы пока не распределяются.',
      'null_cost_means_unknown',true,'explicit_zero_cost_is_valid',true)
  );
end
$function$;

create or replace function public.get_vehicle_operating_summary(p_vehicle_id uuid)
returns jsonb
language sql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
  select public.get_vehicle_operating_period_summary(p_vehicle_id,null,null);
$function$;

revoke all on function public.get_vehicle_operating_period_summary(uuid,timestamptz,timestamptz) from public,anon;
grant execute on function public.get_vehicle_operating_period_summary(uuid,timestamptz,timestamptz) to authenticated;
revoke all on function public.get_vehicle_operating_summary(uuid) from public,anon;
grant execute on function public.get_vehicle_operating_summary(uuid) to authenticated;
