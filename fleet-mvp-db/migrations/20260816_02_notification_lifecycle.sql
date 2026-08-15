-- Fleet MVP notification lifecycle hardening.
-- Applied to Supabase project: fleet-mvp (tikjmiyrhkcjrxjylmqb)
-- Admin correction-submitted notices are resolved when the correction is either
-- accepted (waybill approved) or rejected back to the driver for another pass.

create or replace function private.return_waybill_for_correction_impl(
  p_waybill_id uuid,
  p_correction_type text,
  p_message text
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  wb public.waybills%rowtype;
  cid uuid;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;
  if p_correction_type not in ('closing_readings','route','refuel','other') then
    raise exception 'Invalid correction type';
  end if;
  if nullif(btrim(p_message),'') is null then
    raise exception 'Correction message required';
  end if;

  select * into wb
  from public.waybills
  where id=p_waybill_id
  for update;

  if wb.id is null then raise exception 'Waybill not found'; end if;
  if wb.status not in ('closed_by_driver','under_review') then
    raise exception 'Waybill is not in review';
  end if;
  if exists(
    select 1
    from public.waybill_corrections c
    where c.waybill_id=wb.id and c.status='open'
  ) then
    raise exception 'Open correction already exists';
  end if;

  insert into public.waybill_corrections(
    waybill_id,
    correction_type,
    message,
    created_by,
    original_closing_odometer_km,
    original_closing_fuel_l
  ) values (
    wb.id,
    p_correction_type,
    btrim(p_message),
    auth.uid(),
    wb.closing_odometer_km,
    wb.closing_fuel_l
  ) returning id into cid;

  update public.waybills
  set status='needs_correction', updated_at=now()
  where id=wb.id;

  update public.notifications
  set is_read=true
  where employee_id is null
    and vehicle_id=wb.vehicle_id
    and notification_type='waybill_correction_submitted'
    and title=format('ПЛ %s: исправление отправлено', wb.number)
    and not is_read;

  insert into public.notifications(
    employee_id,
    vehicle_id,
    notification_type,
    title,
    body,
    is_read
  ) values (
    wb.driver_id,
    wb.vehicle_id,
    'waybill_correction',
    format('ПЛ %s возвращён на исправление', wb.number),
    btrim(p_message),
    false
  );

  return cid;
end
$function$;

create or replace function private.approve_waybill_impl(p_waybill_id uuid)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  wb public.waybills%rowtype;
  previous_wb public.waybills%rowtype;
  calc record;
  route_km numeric:=0;
  refuel_sum numeric:=0;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;

  select * into wb
  from public.waybills
  where id=p_waybill_id
  for update;

  if wb.id is null then raise exception 'Waybill not found'; end if;
  if wb.status not in ('closed_by_driver','under_review') then
    raise exception 'Waybill is not ready for approval';
  end if;
  if wb.closing_odometer_km is null or wb.closing_fuel_l is null then
    raise exception 'Closing state is incomplete';
  end if;
  if exists(
    select 1 from public.waybill_corrections
    where waybill_id=wb.id and status='open'
  ) then
    raise exception 'Open correction must be completed first';
  end if;
  if exists(
    select 1 from public.waybill_reconciliations
    where waybill_id=wb.id and status='open'
  ) then
    raise exception 'Opening odometer discrepancy must be reconciled first';
  end if;

  select * into calc
  from public.v_waybill_calculations
  where waybill_id=wb.id;

  select coalesce(sum(r.distance_km),0) into route_km
  from public.v_waybill_route_legs r
  where r.waybill_id=wb.id;

  select coalesce(sum(f.quantity_l),0) into refuel_sum
  from public.fuel_transactions f
  where f.waybill_id=wb.id;

  if calc.mileage_km is not null and abs(route_km-calc.mileage_km)>1 then
    raise exception 'Route coverage check failed: waybill % km, route % km',calc.mileage_km,route_km;
  end if;
  if calc.fuel_received_l is not null and abs(refuel_sum-calc.fuel_received_l)>0.01 then
    raise exception 'Refuel reconciliation check failed: accounting % L, transactions % L',calc.fuel_received_l,refuel_sum;
  end if;

  select * into previous_wb
  from public.waybills
  where vehicle_id=wb.vehicle_id
    and id<>wb.id
    and status in ('approved','archived')
    and coalesce(closed_at,valid_to)<=coalesce(wb.closed_at,wb.valid_to)
  order by coalesce(closed_at,valid_to) desc
  limit 1;

  if previous_wb.id is not null then
    if wb.opening_odometer_km is distinct from previous_wb.closing_odometer_km then
      raise exception 'Odometer continuity check failed';
    end if;
    if wb.opening_fuel_l is distinct from previous_wb.closing_fuel_l then
      raise exception 'Fuel continuity check failed';
    end if;
  end if;

  update public.waybills
  set status='approved',approved_at=now(),approved_by=auth.uid(),updated_at=now()
  where id=wb.id;

  update public.vehicles
  set current_odometer_km=wb.closing_odometer_km,
      current_fuel_l=wb.closing_fuel_l,
      updated_at=now()
  where id=wb.vehicle_id;

  update public.waybill_corrections
  set status='resolved',resolved_at=now()
  where waybill_id=wb.id and status='submitted';

  update public.notifications
  set is_read=true
  where employee_id is null
    and vehicle_id=wb.vehicle_id
    and notification_type='waybill_correction_submitted'
    and title=format('ПЛ %s: исправление отправлено', wb.number)
    and not is_read;

  insert into public.vehicle_state_snapshots(
    vehicle_id,
    snapshot_at,
    odometer_km,
    fuel_l,
    source,
    is_confirmed,
    notes
  ) values (
    wb.vehicle_id,
    coalesce(wb.closed_at,now()),
    wb.closing_odometer_km,
    wb.closing_fuel_l,
    'admin',
    true,
    concat('Утверждение ПЛ ',wb.number)
  )
  on conflict(vehicle_id,snapshot_at) do update
  set odometer_km=excluded.odometer_km,
      fuel_l=excluded.fuel_l,
      is_confirmed=true,
      notes=excluded.notes;
end;
$function$;
