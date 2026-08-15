-- Fleet MVP time-boundary consistency for waybill issuance.
-- Both public and private issue-waybill layers must evaluate the driver's
-- license against the same Europe/Moscow calendar date.

create or replace function public.issue_waybill_v2(
  p_number text,
  p_vehicle_id uuid,
  p_driver_id uuid,
  p_valid_from timestamptz,
  p_valid_to timestamptz,
  p_trailer_id uuid,
  p_authorization_text text,
  p_purpose_text text,
  p_exploitation_group text,
  p_cargo_name text,
  p_cargo_mass_t numeric,
  p_senior_vehicle_employee_id uuid,
  p_responsible_employee_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  v_license_valid_to date;
  required_valid_to date;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Действие доступно только администратору';
  end if;

  required_valid_to := (p_valid_to at time zone 'Europe/Moscow')::date;

  select d.license_valid_to into v_license_valid_to
  from public.drivers d
  where d.employee_id=p_driver_id;

  if v_license_valid_to is null then
    raise exception 'Не указан срок действия удостоверения водителя';
  end if;
  if v_license_valid_to < required_valid_to then
    raise exception 'Удостоверение водителя не действует до конца путевого листа';
  end if;

  return private.issue_waybill_v2_impl(
    p_number,p_vehicle_id,p_driver_id,p_valid_from,p_valid_to,p_trailer_id,p_authorization_text,p_purpose_text,
    p_exploitation_group,p_cargo_name,p_cargo_mass_t,p_senior_vehicle_employee_id,p_responsible_employee_id
  );
end
$function$;
