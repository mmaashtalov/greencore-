alter table public.fuel_transactions add column if not exists cost_amount numeric;

do $block$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.fuel_transactions'::regclass
      and conname='fuel_transactions_cost_amount_nonnegative'
  ) then
    alter table public.fuel_transactions
      add constraint fuel_transactions_cost_amount_nonnegative
      check (cost_amount is null or cost_amount>=0);
  end if;
end
$block$;

create or replace function private.record_refuel_impl(
  p_waybill_id uuid,
  p_quantity_l numeric,
  p_odometer_km numeric,
  p_cost_amount numeric,
  p_occurred_at timestamptz,
  p_client_action_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  wb public.waybills%rowtype;
  v public.vehicles%rowtype;
  fuel_type uuid;
  tx_id uuid;
  event_time timestamptz;
  last_odo numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_client_action_id is null then raise exception 'Client action id is required'; end if;
  select * into wb from public.waybills where id=p_waybill_id;
  if wb.id is null then raise exception 'Waybill not found'; end if;
  if wb.driver_id is distinct from private.current_employee_id() then raise exception 'Waybill does not belong to current driver'; end if;

  select id into tx_id from public.fuel_transactions where client_action_id=p_client_action_id and waybill_id=p_waybill_id;
  if tx_id is not null then return tx_id; end if;

  if p_quantity_l is null or p_quantity_l<=0 then raise exception 'Refuel quantity must be positive'; end if;
  if p_odometer_km is null or p_odometer_km<0 then raise exception 'Invalid odometer'; end if;
  if p_cost_amount is not null and p_cost_amount<0 then raise exception 'Refuel cost cannot be negative'; end if;
  event_time:=coalesce(p_occurred_at,now());
  if wb.status<>'active' then raise exception 'Waybill is not active'; end if;
  if event_time<wb.valid_from or event_time>=wb.valid_to then raise exception 'Fuel event timestamp is outside waybill validity'; end if;
  select * into v from public.vehicles where id=wb.vehicle_id;
  fuel_type:=v.fuel_type_id;
  if fuel_type is null then raise exception 'Vehicle fuel type is not configured'; end if;
  if v.tank_capacity_l is not null and p_quantity_l>v.tank_capacity_l then raise exception 'Refuel quantity exceeds tank capacity'; end if;
  select e.odometer_km into last_odo from public.waybill_events e where e.waybill_id=wb.id and e.odometer_km is not null and e.occurred_at<=event_time order by e.occurred_at desc,e.created_at desc limit 1;
  if last_odo is not null and p_odometer_km<last_odo then raise exception 'Odometer cannot decrease'; end if;

  insert into public.fuel_transactions(waybill_id,vehicle_id,driver_id,occurred_at,fuel_type_id,quantity_l,odometer_km,cost_amount,source,client_action_id)
  values(wb.id,wb.vehicle_id,wb.driver_id,event_time,fuel_type,p_quantity_l,p_odometer_km,p_cost_amount,'manual',p_client_action_id)
  returning id into tx_id;
  return tx_id;
end
$function$;

create or replace function private.record_refuel_impl(
  p_waybill_id uuid,
  p_quantity_l numeric,
  p_odometer_km numeric,
  p_occurred_at timestamptz,
  p_client_action_id uuid
)
returns uuid
language sql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
  select private.record_refuel_impl(p_waybill_id,p_quantity_l,p_odometer_km,null,p_occurred_at,p_client_action_id);
$function$;

create or replace function public.record_refuel(
  p_waybill_id uuid,
  p_quantity_l numeric,
  p_odometer_km numeric,
  p_cost_amount numeric,
  p_occurred_at timestamptz,
  p_client_action_id uuid
)
returns uuid
language sql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
  select private.record_refuel_impl(p_waybill_id,p_quantity_l,p_odometer_km,p_cost_amount,p_occurred_at,p_client_action_id);
$function$;

create or replace function public.record_refuel(
  p_waybill_id uuid,
  p_quantity_l numeric,
  p_odometer_km numeric,
  p_occurred_at timestamptz,
  p_client_action_id uuid
)
returns uuid
language sql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
  select private.record_refuel_impl(p_waybill_id,p_quantity_l,p_odometer_km,null,p_occurred_at,p_client_action_id);
$function$;

create or replace function public.get_driver_action_form(p_action text,p_waybill_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare x jsonb;
begin
  x:=private.get_driver_action_form_impl(p_action,p_waybill_id);
  if p_action='finish_waybill' then
    x:=jsonb_set(x,'{fields,0,label}',to_jsonb('Одометр при закрытии, км'::text),false);
    x:=jsonb_set(x,'{subtitle}',to_jsonb('Введите показание одометра на приборной панели и фактический остаток топлива. Пробег за ПЛ система рассчитает сама.'::text),true);
  elsif p_action='refuel' then
    x:=jsonb_set(x,'{fields}',coalesce(x->'fields','[]'::jsonb)||jsonb_build_array(
      jsonb_build_object('id','cost_amount','label','Стоимость заправки, ₽','required',false,'input','number','min',0,'step',0.01)
    ),false);
    x:=jsonb_set(x,'{subtitle}',to_jsonb('Стоимость можно оставить пустой, если она неизвестна. 0 ₽ означает, что денежных затрат действительно не было.'::text),true);
    x:=jsonb_set(x,'{ux_rules,max_fields}','3'::jsonb,true);
  end if;
  return x;
end
$function$;

create or replace function public.get_vehicle_operating_summary(p_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  v public.vehicles%rowtype;
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
  v_known_cost_per_1000 numeric;
  v_service_complete boolean:=true;
  v_trip_complete boolean:=true;
  v_fuel_money_complete boolean:=true;
  v_status text;
  v_label text;
  v_note text;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
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
  where c.vehicle_id=v.id and c.status::text in ('approved','archived','closed_by_incident');

  select count(ft.id)::integer,
         count(ft.id) filter (where ft.cost_amount is not null)::integer,
         coalesce(sum(ft.cost_amount) filter (where ft.cost_amount is not null),0)
    into v_fuel_tx_count,v_fuel_priced,v_fuel_cost
  from public.fuel_transactions ft
  join public.waybills wb on wb.id=ft.waybill_id
  where ft.vehicle_id=v.id and wb.status::text in ('approved','archived','closed_by_incident');

  select count(*)::integer,
         count(*) filter (where me.cost_amount is not null)::integer,
         coalesce(sum(me.cost_amount) filter (where me.cost_amount is not null),0)
    into v_maint_count,v_maint_priced,v_maint_cost
  from public.maintenance_events me
  where me.vehicle_id=v.id and me.status::text='completed';

  select count(*)::integer,count(*) filter (where r.status='closed')::integer
    into v_repair_count,v_closed_repairs
  from public.repair_cases r where r.vehicle_id=v.id;

  select count(*)::integer into v_closed_without_work
  from public.repair_cases r
  where r.vehicle_id=v.id and r.status='closed'
    and not exists(select 1 from public.repair_work_items w where w.repair_case_id=r.id and w.completed_at is not null);

  select count(w.id)::integer,
         count(w.id) filter (where w.cost_amount is not null)::integer,
         coalesce(sum(w.cost_amount) filter (where w.cost_amount is not null),0)
    into v_work_count,v_work_priced,v_repair_cost
  from public.repair_cases r
  join public.repair_work_items w on w.repair_case_id=r.id and w.completed_at is not null
  where r.vehicle_id=v.id;

  v_service_cost:=coalesce(v_maint_cost,0)+coalesce(v_repair_cost,0);
  v_known_cost:=v_service_cost+coalesce(v_fuel_cost,0);
  v_known_cost_available:=(v_maint_priced+v_work_priced+v_fuel_priced)>0;
  v_service_complete:=
    (v_maint_count+v_repair_count)=0 or
    (v_maint_priced=v_maint_count and v_work_priced=v_work_count and v_closed_without_work=0);
  v_trip_complete:=v_final_waybills=0 or (v_mileage_waybills=v_final_waybills and v_fuel_waybills=v_final_waybills);
  v_fuel_money_complete:=v_fuel_tx_count=0 or v_fuel_priced=v_fuel_tx_count;

  if v_mileage>0 and v_fuel_waybills>0 then v_avg_l100:=round((v_consumed*100/nullif(v_mileage,0))::numeric,2); end if;
  if v_known_cost_available and v_mileage>0 then v_known_cost_per_1000:=round((v_known_cost*1000/nullif(v_mileage,0))::numeric,2); end if;

  if v_final_waybills=0 and (v_maint_count+v_repair_count)=0 then
    v_status:='no_history'; v_label:='История эксплуатации ещё не накоплена'; v_note:='Показатели появятся после закрытых путевых листов, ТО или ремонтов.';
  elsif not v_trip_complete or not v_service_complete or not v_fuel_money_complete then
    v_status:='partial'; v_label:='История заполнена частично'; v_note:='Показаны только подтверждённые значения. Неизвестные суммы не заменяются нулём.';
  else
    v_status:='recorded_complete'; v_label:='Записанная история согласована'; v_note:='Все существующие записи движения, заправок и сервиса имеют достаточные исходные данные.';
  end if;

  return jsonb_build_object(
    'ui_version','vehicle_operating_summary_v2',
    'scope',jsonb_build_object('kind','all_recorded_history','label','За всю записанную историю'),
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
      'monetary_cost_note',case when v_fuel_tx_count=0 then 'Заправок в подтверждённой истории нет.' when v_fuel_money_complete then 'Стоимость указана для всех сохранённых заправок.' else 'Часть заправок не имеет стоимости. Пустая сумма не считается нулём.' end
    ),
    'service',jsonb_build_object(
      'maintenance_completed',v_maint_count,'maintenance_priced',v_maint_priced,'maintenance_missing_cost',greatest(v_maint_count-v_maint_priced,0),'maintenance_recorded_cost',v_maint_cost,
      'repair_count',v_repair_count,'closed_repair_count',v_closed_repairs,'closed_repairs_without_work_log',v_closed_without_work,
      'repair_work_items',v_work_count,'repair_priced_work_items',v_work_priced,'repair_unpriced_work_items',greatest(v_work_count-v_work_priced,0),'repair_recorded_cost',v_repair_cost,
      'recorded_service_cost',case when (v_maint_priced+v_work_priced)>0 then v_service_cost else null end,
      'cost_available',((v_maint_priced+v_work_priced)>0),'complete',v_service_complete
    ),
    'money',jsonb_build_object(
      'recorded_known_cost',case when v_known_cost_available then v_known_cost else null end,
      'recorded_known_cost_available',v_known_cost_available,
      'recorded_known_cost_complete',(v_service_complete and v_fuel_money_complete),
      'recorded_known_cost_per_1000km',v_known_cost_per_1000
    ),
    'completeness',jsonb_build_object('status',v_status,'label',v_label,'note',v_note,'trip_data_complete',v_trip_complete,'service_cost_complete',v_service_complete,'fuel_cost_complete',v_fuel_money_complete),
    'cost_model',jsonb_build_object(
      'total_operating_cost_supported',false,
      'recorded_direct_cost_supported',true,
      'reason','Полная себестоимость пока не рассчитывается: стоимость топлива учитывается только по заправкам с явно указанной суммой; стоимость начальных остатков топлива и складского отпуска не оценена.',
      'null_cost_means_unknown',true,'explicit_zero_cost_is_valid',true
    )
  );
end
$function$;

revoke all on function public.record_refuel(uuid,numeric,numeric,numeric,timestamptz,uuid) from public,anon;
grant execute on function public.record_refuel(uuid,numeric,numeric,numeric,timestamptz,uuid) to authenticated;
revoke all on function public.record_refuel(uuid,numeric,numeric,timestamptz,uuid) from public,anon;
grant execute on function public.record_refuel(uuid,numeric,numeric,timestamptz,uuid) to authenticated;
revoke all on function public.get_driver_action_form(text,uuid) from public,anon;
grant execute on function public.get_driver_action_form(text,uuid) to authenticated;
revoke all on function public.get_vehicle_operating_summary(uuid) from public,anon;
grant execute on function public.get_vehicle_operating_summary(uuid) to authenticated;
