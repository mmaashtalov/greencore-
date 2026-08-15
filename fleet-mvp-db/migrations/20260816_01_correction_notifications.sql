-- Fleet MVP database hotfix history
-- Applied to Supabase project: fleet-mvp (tikjmiyrhkcjrxjylmqb)
-- Purpose: close the waybill correction notification loop in both directions.
-- This file records the already-verified live definitions so the cloud state is reproducible.

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
  where id = p_waybill_id
  for update;

  if wb.id is null then raise exception 'Waybill not found'; end if;
  if wb.status not in ('closed_by_driver','under_review') then
    raise exception 'Waybill is not in review';
  end if;
  if exists (
    select 1
    from public.waybill_corrections c
    where c.waybill_id = wb.id and c.status = 'open'
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
  set status = 'needs_correction', updated_at = now()
  where id = wb.id;

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

create or replace function private.submit_waybill_correction_impl(
  p_correction_id uuid,
  p_response_text text default null::text,
  p_closing_odometer_km numeric default null::numeric,
  p_closing_fuel_l numeric default null::numeric
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  emp uuid;
  c public.waybill_corrections%rowtype;
  wb public.waybills%rowtype;
  final_event_id uuid;
  prior_odo numeric;
  notify_body text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  emp := private.current_employee_id();
  if emp is null then raise exception 'Employee profile not found'; end if;

  select * into c
  from public.waybill_corrections
  where id = p_correction_id
  for update;

  if c.id is null or c.status <> 'open' then
    raise exception 'Correction request is not open';
  end if;

  select * into wb
  from public.waybills
  where id = c.waybill_id
  for update;

  if wb.id is null or wb.driver_id <> emp or wb.status <> 'needs_correction' then
    raise exception 'Waybill is not available for correction';
  end if;

  if c.correction_type = 'closing_readings' then
    if p_closing_odometer_km is null or p_closing_fuel_l is null then
      raise exception 'Closing odometer and fuel are required';
    end if;
    if p_closing_odometer_km < coalesce(wb.opening_odometer_km, 0) then
      raise exception 'Closing odometer is below opening odometer';
    end if;
    if p_closing_fuel_l < 0 then
      raise exception 'Closing fuel cannot be negative';
    end if;

    select id into final_event_id
    from public.waybill_events
    where waybill_id = wb.id and event_type = 'parked'
    order by occurred_at desc, created_at desc
    limit 1;

    select max(odometer_km) into prior_odo
    from public.waybill_events
    where waybill_id = wb.id
      and odometer_km is not null
      and (final_event_id is null or id <> final_event_id);

    if prior_odo is not null and p_closing_odometer_km < prior_odo then
      raise exception 'Closing odometer is below previous recorded odometer';
    end if;

    update public.waybills
    set closing_odometer_km = p_closing_odometer_km,
        closing_fuel_l = p_closing_fuel_l,
        status = 'closed_by_driver',
        updated_at = now()
    where id = wb.id;

    if final_event_id is not null then
      update public.waybill_events
      set odometer_km = p_closing_odometer_km
      where id = final_event_id;
    end if;

    notify_body := format(
      'Водитель исправил конечные показания: одометр %s км, остаток топлива %s л.',
      p_closing_odometer_km,
      p_closing_fuel_l
    );
  else
    if nullif(btrim(p_response_text), '') is null then
      raise exception 'Explanation is required';
    end if;

    update public.waybills
    set status = 'closed_by_driver', updated_at = now()
    where id = wb.id;

    notify_body := btrim(p_response_text);
  end if;

  update public.waybill_corrections
  set status = 'submitted',
      response_text = nullif(btrim(p_response_text), ''),
      submitted_by = auth.uid(),
      submitted_at = now(),
      corrected_closing_odometer_km = case
        when c.correction_type = 'closing_readings' then p_closing_odometer_km
        else null
      end,
      corrected_closing_fuel_l = case
        when c.correction_type = 'closing_readings' then p_closing_fuel_l
        else null
      end
  where id = c.id;

  update public.notifications
  set is_read = true
  where employee_id = emp
    and vehicle_id = wb.vehicle_id
    and notification_type = 'waybill_correction'
    and not is_read;

  insert into public.notifications(
    employee_id,
    vehicle_id,
    notification_type,
    title,
    body,
    is_read
  ) values (
    null,
    wb.vehicle_id,
    'waybill_correction_submitted',
    format('ПЛ %s: исправление отправлено', wb.number),
    coalesce(
      nullif(notify_body, ''),
      'Водитель отправил исправление на повторную проверку.'
    ),
    false
  );

  return jsonb_build_object(
    'waybill_id', wb.id,
    'status_label', 'Отправлено на повторную проверку',
    'message', 'Исправление сохранено'
  );
end
$function$;
