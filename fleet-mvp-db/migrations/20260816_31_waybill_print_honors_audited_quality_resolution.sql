create or replace function public.get_waybill_print_preflight(p_waybill_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  w public.waybills%rowtype;
  h record;
  c record;
  qr record;
  route_count integer:=0;
  route_km numeric:=0;
  refuel_sum numeric:=0;
  med_count integer:=0;
  tech_count integer:=0;
  is_final boolean:=false;
  strict_closed boolean:=false;
  closed_state boolean:=false;
  legacy_resolution boolean:=false;
  header_ok boolean:=false;
  period_ok boolean:=false;
  close_ok boolean:=true;
  route_ok boolean:=true;
  overflow_ok boolean:=true;
  fuel_ok boolean:=true;
  movement_order_ok boolean:=true;
  movement_complete boolean:=false;
  paper_details_ok boolean:=false;
  medical_ok boolean:=false;
  technical_ok boolean:=false;
  quality_ready boolean:=false;
  print_allowed boolean:=false;
  blocking_count integer:=0;
  warning_count integer:=0;
  mode text;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into w from public.waybills where id=p_waybill_id;
  if w.id is null then raise exception 'Waybill not found'; end if;
  select * into h from public.v_waybill_print_header where waybill_id=w.id;
  select * into c from public.v_waybill_calculations where waybill_id=w.id;
  select count(*)::integer,coalesce(sum(distance_km),0) into route_count,route_km from public.v_waybill_route_legs where waybill_id=w.id;
  select coalesce(sum(quantity_l),0) into refuel_sum from public.fuel_transactions where waybill_id=w.id;
  select count(*) filter(where clearance_type::text in ('medical_pretrip','medical'))::integer,
         count(*) filter(where clearance_type::text in ('technical_pretrip','technical'))::integer
    into med_count,tech_count
    from public.v_waybill_clearances_print where waybill_id=w.id;
  select qr0.* into qr
    from public.waybill_quality_resolutions qr0
    where qr0.waybill_id=w.id and qr0.revoked_at is null
    order by qr0.created_at desc limit 1;

  is_final:=w.status in ('approved','archived');
  strict_closed:=w.status in ('approved','archived','closed_by_incident');
  closed_state:=w.status in ('closed_by_driver','under_review','needs_correction','approved','archived','closed_by_incident');
  legacy_resolution:=is_final and qr.id is not null;
  mode:=case when is_final then 'final' when closed_state then 'review' else 'working' end;

  header_ok:=nullif(btrim(w.number),'') is not null
    and h.vehicle_registration_number is not null
    and nullif(btrim(h.driver_full_name),'') is not null
    and w.valid_from is not null and w.valid_to is not null
    and nullif(btrim(h.organization_name),'') is not null
    and nullif(btrim(h.organization_location),'') is not null
    and h.actual_opening_odometer_km is not null
    and h.opening_fuel_l is not null;
  period_ok:=w.valid_from is not null and w.valid_to is not null
    and w.valid_to>w.valid_from
    and w.valid_to<=w.valid_from+interval '10 days 1 minute';
  overflow_ok:=route_count<=12;
  close_ok:=not closed_state or (h.actual_closing_odometer_km is not null and h.closing_fuel_l is not null);
  route_ok:=case when c.mileage_km is null then true when abs(coalesce(route_km,0)-c.mileage_km)<=1 then true else false end;
  fuel_ok:=case when c.fuel_received_l is null then true when abs(coalesce(refuel_sum,0)-c.fuel_received_l)<=0.01 then true else false end;
  movement_order_ok:=h.actual_departure_at is null or h.actual_return_at is null or h.actual_return_at>=h.actual_departure_at;
  movement_complete:=h.actual_departure_at is not null and h.actual_return_at is not null;
  paper_details_ok:=nullif(btrim(w.authorization_text),'') is not null and nullif(btrim(w.purpose_text),'') is not null;
  medical_ok:=med_count>0;
  technical_ok:=tech_count>0;

  blocking_count:=(case when header_ok then 0 else 1 end)
    +(case when period_ok then 0 else 1 end)
    +(case when overflow_ok then 0 else 1 end)
    +(case when close_ok then 0 else 1 end)
    +(case when movement_order_ok then 0 else 1 end)
    +(case when strict_closed and not route_ok and not legacy_resolution then 1 else 0 end)
    +(case when strict_closed and not fuel_ok and not legacy_resolution then 1 else 0 end);
  warning_count:=(case when closed_state and not movement_complete then 1 else 0 end)
    +(case when not paper_details_ok then 1 else 0 end)
    +(case when not medical_ok then 1 else 0 end)
    +(case when not technical_ok then 1 else 0 end)
    +(case when not strict_closed and not route_ok then 1 else 0 end)
    +(case when not strict_closed and not fuel_ok then 1 else 0 end)
    +(case when legacy_resolution and (not route_ok or not fuel_ok) then 1 else 0 end);

  print_allowed:=blocking_count=0;
  quality_ready:=print_allowed and warning_count=0;

  return jsonb_build_object(
    'ui_version','waybill_print_preflight_v3',
    'waybill',jsonb_build_object('id',w.id,'number',w.number,'status',w.status,'mode',mode,'strict_closed',strict_closed),
    'format',jsonb_build_object('paper','A4','orientation','landscape','pages',2,'duplex',true,'scale_percent',100,'margin_mm',5,'route_columns',16,'route_capacity',12),
    'stats',jsonb_build_object('route_rows',route_count,'route_km',route_km,'mileage_km',c.mileage_km,'refuel_sum_l',refuel_sum,'fuel_received_l',c.fuel_received_l,'blocking_count',blocking_count,'warning_count',warning_count),
    'quality_resolution',case when not legacy_resolution then null else jsonb_build_object('id',qr.id,'type',qr.resolution_type,'note',qr.note,'created_at',qr.created_at) end,
    'checks',jsonb_build_array(
      jsonb_build_object('id','header','ok',header_ok,'blocking',true,'label',case when header_ok then 'Основные реквизиты и начальные показания заполнены' else 'Не заполнены основные реквизиты, организация или начальные показания' end),
      jsonb_build_object('id','period','ok',period_ok,'blocking',true,'label',case when period_ok then 'Период ПЛ корректен' else 'Некорректный период: окончание должно быть позже начала и не более 10 дней' end),
      jsonb_build_object('id','overflow','ok',overflow_ok,'blocking',true,'label',case when overflow_ok then 'Маршрут помещается на типовой оборот' else 'Маршрут не помещается на типовой оборот' end),
      jsonb_build_object('id','closing','ok',close_ok,'blocking',closed_state,'label',case when close_ok then case when closed_state then 'Закрывающие показания заполнены' else 'ПЛ ещё не требует закрывающих показаний' end else 'Нет закрывающих показаний пробега или топлива' end),
      jsonb_build_object('id','movement_order','ok',movement_order_ok,'blocking',true,'label',case when movement_order_ok then 'Хронология выезда/возвращения не содержит противоречий' else 'Возвращение указано раньше выезда' end),
      jsonb_build_object('id','route','ok',route_ok,'blocking',(strict_closed and not legacy_resolution),'label',case when c.mileage_km is null then 'Пробег ещё не закрыт' when route_ok then 'Маршрут покрывает подтверждённый пробег' when legacy_resolution then 'Маршрут не покрывает пробег; историческое расхождение оформлено аудированным решением' else 'Маршрут не покрывает подтверждённый пробег полностью' end),
      jsonb_build_object('id','fuel','ok',fuel_ok,'blocking',(strict_closed and not legacy_resolution),'label',case when fuel_ok then 'Заправки сходятся с учётом топлива' when legacy_resolution then 'Заправки не сходятся; историческое расхождение оформлено аудированным решением' else 'Сумма заправок не сходится с учётом топлива' end),
      jsonb_build_object('id','quality_resolution','ok',(not legacy_resolution or qr.id is not null),'blocking',false,'label',case when legacy_resolution then case qr.resolution_type when 'source_document_verified' then 'Историческое расхождение подтверждено по первичному документу' else 'Историческое расхождение оформлено как наследованное исключение' end else 'Отдельное решение по качеству не требуется' end),
      jsonb_build_object('id','movement_marks','ok',movement_complete,'blocking',false,'label',case when movement_complete then 'Системные отметки выезда и возвращения есть' else 'Нет полной системной пары выезд/возвращение — проверьте бумажные отметки' end),
      jsonb_build_object('id','paper_details','ok',paper_details_ok,'blocking',false,'label',case when paper_details_ok then 'Основание и цель заполнены' else 'Основание или цель не заполнены' end),
      jsonb_build_object('id','medical','ok',medical_ok,'blocking',false,'label',case when medical_ok then 'Предрейсовый медосмотр зафиксирован' else 'Предрейсовый медосмотр не зафиксирован в системе' end),
      jsonb_build_object('id','technical','ok',technical_ok,'blocking',false,'label',case when technical_ok then 'Предрейсовая техпроверка зафиксирована' else 'Предрейсовая техпроверка не зафиксирована в системе' end)
    ),
    'print_allowed',print_allowed,
    'quality_ready',quality_ready,
    'message',case when not print_allowed then 'Печать остановлена: устраните блокирующие замечания' when warning_count>0 then 'Печать разрешена, но есть замечания для проверки' else 'Документ прошёл контроль печати' end
  );
end
$function$;

revoke all on function public.get_waybill_print_preflight(uuid) from public,anon;
grant execute on function public.get_waybill_print_preflight(uuid) to authenticated;
