-- Fleet MVP correction-type compatibility hardening.
-- Applied to Supabase project: fleet-mvp (tikjmiyrhkcjrxjylmqb)
-- Older cached clients used `closing_state`; canonical database value is
-- `closing_readings`. Normalize the legacy value at the server boundary.

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
  correction_type text;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;

  correction_type := case
    when p_correction_type = 'closing_state' then 'closing_readings'
    else p_correction_type
  end;

  if correction_type not in ('closing_readings','route','refuel','other') then
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
    correction_type,
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
