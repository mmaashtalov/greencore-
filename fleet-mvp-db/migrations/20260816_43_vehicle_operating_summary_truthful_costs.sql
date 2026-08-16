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
  v_service_cost_available boolean:=false;
  v_service_per_1000 numeric;
  v_service_complete boolean:=false;
  v_trip_complete boolean:=false;
  v_status text;
  v_label text;
  v_note text;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;

  select * into v from public.vehicles where id=p_vehicle_id;
  if v.id is null then raise exception 'Vehicle not found'; end if;

  select
    count(*)::integer,
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
  where c.vehicle_id=v.id
    and c.status::text in ('approved','archived','closed_by_incident');

  select
    count(*)::integer,
    count(*) filter (where me.cost_amount is not null)::integer,
    coalesce(sum(me.cost_amount) filter (where me.cost_amount is not null),0)
  into v_maint_count,v_maint_priced,v_maint_cost
  from public.maintenance_events me
  where me.vehicle_id=v.id and me.status::text='completed';

  select
    count(*)::integer,
    count(*) filter (where r.status='closed')::integer
  into v_repair_count,v_closed_repairs
  from public.repair_cases r where r.vehicle_id=v.id;

  select count(*)::integer into v_closed_without_work
  from public.repair_cases r
  where r.vehicle_id=v.id and r.status='closed'
    and not exists (
      select 1 from public.repair_work_items w
      where w.repair_case_id=r.id and w.completed_at is not null
    );

  select
    count(w.id)::integer,
    count(w.id) filter (where w.cost_amount is not null)::integer,
    coalesce(sum(w.cost_amount) filter (where w.cost_amount is not null),0)
  into v_work_count,v_work_priced,v_repair_cost
  from public.repair_cases r
  join public.repair_work_items w on w.repair_case_id=r.id and w.completed_at is not null
  where r.vehicle_id=v.id;

  v_service_cost:=coalesce(v_maint_cost,0)+coalesce(v_repair_cost,0);
  v_service_cost_available:=(v_maint_priced+v_work_priced)>0;
  v_service_complete:=
    (v_maint_count+v_repair_count)>0
    and v_maint_priced=v_maint_count
    and v_work_priced=v_work_count
    and v_closed_without_work=0;
  v_trip_complete:=v_final_waybills>0 and v_mileage_waybills=v_final_waybills and v_fuel_waybills=v_final_waybills;

  if v_mileage>0 and v_consumed>=0 and v_fuel_waybills>0 then
    v_avg_l100:=round((v_consumed*100/nullif(v_mileage,0))::numeric,2);
  end if;
  if v_service_cost_available and v_mileage>0 then
    v_service_per_1000:=round((v_service_cost*1000/nullif(v_mileage,0))::numeric,2);
  end if;

  if v_final_waybills=0 and (v_maint_count+v_repair_count)=0 then
    v_status:='no_history';
    v_label:='История эксплуатации ещё не накоплена';
    v_note:='Показатели появятся после закрытых путевых листов, ТО или ремонтов.';
  elsif not v_trip_complete or ((v_maint_count+v_repair_count)>0 and not v_service_complete) then
    v_status:='partial';
    v_label:='История заполнена частично';
    v_note:='Показаны только подтверждённые значения. Пробелы не заменяются нулём.';
  else
    v_status:='recorded_complete';
    v_label:='Записанная история согласована';
    v_note:='Пробег, топливо и сохранённые сервисные записи имеют достаточные исходные данные.';
  end if;

  return jsonb_build_object(
    'ui_version','vehicle_operating_summary_v1',
    'scope',jsonb_build_object('kind','all_recorded_history','label','За всю записанную историю'),
    'vehicle',jsonb_build_object(
      'id',v.id,
      'label',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,''))
    ),
    'movement',jsonb_build_object(
      'finalized_waybills',v_final_waybills,
      'mileage_complete_waybills',v_mileage_waybills,
      'confirmed_mileage_km',v_mileage,
      'complete',(v_final_waybills>0 and v_mileage_waybills=v_final_waybills)
    ),
    'fuel',jsonb_build_object(
      'balance_complete_waybills',v_fuel_waybills,
      'refuel_count',v_refuels,
      'received_l',v_received,
      'actual_consumption_l',v_consumed,
      'normative_consumption_l',v_normative,
      'variance_l',v_variance,
      'average_l_per_100km',v_avg_l100,
      'complete',(v_final_waybills>0 and v_fuel_waybills=v_final_waybills),
      'monetary_cost_available',false,
      'monetary_cost_note','В учёте заправок пока нет цены топлива, поэтому денежная стоимость топлива не рассчитывается.'
    ),
    'service',jsonb_build_object(
      'maintenance_completed',v_maint_count,
      'maintenance_priced',v_maint_priced,
      'maintenance_missing_cost',greatest(v_maint_count-v_maint_priced,0),
      'maintenance_recorded_cost',v_maint_cost,
      'repair_count',v_repair_count,
      'closed_repair_count',v_closed_repairs,
      'closed_repairs_without_work_log',v_closed_without_work,
      'repair_work_items',v_work_count,
      'repair_priced_work_items',v_work_priced,
      'repair_unpriced_work_items',greatest(v_work_count-v_work_priced,0),
      'repair_recorded_cost',v_repair_cost,
      'recorded_service_cost',case when v_service_cost_available then v_service_cost else null end,
      'recorded_service_cost_per_1000km',v_service_per_1000,
      'cost_available',v_service_cost_available,
      'complete',v_service_complete
    ),
    'completeness',jsonb_build_object(
      'status',v_status,
      'label',v_label,
      'note',v_note,
      'trip_data_complete',v_trip_complete,
      'service_cost_complete',v_service_complete
    ),
    'cost_model',jsonb_build_object(
      'total_operating_cost_supported',false,
      'reason','Денежная цена топлива пока не хранится. Нельзя складывать сервисные расходы и топливо в одну сумму.',
      'service_money_is_recorded_only',true,
      'fuel_is_volume_only',true,
      'null_cost_means_unknown',true,
      'explicit_zero_cost_is_valid',true
    )
  );
end
$function$;

revoke all on function public.get_vehicle_operating_summary(uuid) from public,anon;
grant execute on function public.get_vehicle_operating_summary(uuid) to authenticated;
