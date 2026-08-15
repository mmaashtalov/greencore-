-- Fleet MVP waybill issue/start notification lifecycle.
-- Applied to Supabase project: fleet-mvp (tikjmiyrhkcjrxjylmqb)
-- A newly issued waybill becomes an addressable driver task. The notice is
-- automatically resolved when the driver successfully starts that waybill.

create or replace function private.issue_waybill_v2_impl(
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
  norm public.vehicle_fuel_norms%rowtype;
  last_wb public.waybills%rowtype;
  v public.vehicles%rowtype;
  t public.vehicles%rowtype;
  new_id uuid;
  missing_category public.license_category;
  org_id uuid;
  license_valid_to date;
  required_valid_to date;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  if p_number is null or btrim(p_number)='' then raise exception 'Waybill number required'; end if;
  if p_valid_to <= p_valid_from then raise exception 'Invalid validity period'; end if;
  if p_cargo_mass_t is not null and p_cargo_mass_t < 0 then raise exception 'Cargo mass cannot be negative'; end if;
  required_valid_to := (p_valid_to at time zone 'Europe/Moscow')::date;

  select * into v from public.vehicles where id=p_vehicle_id for update;
  if v.id is null then raise exception 'Vehicle not found'; end if;
  if v.asset_type <> 'self_propelled' then raise exception 'Cannot issue waybill for trailer'; end if;
  if v.status not in ('operational','reserve') then raise exception 'Vehicle is not available for operation'; end if;
  if exists(select 1 from public.waybills w where w.vehicle_id=p_vehicle_id and w.status in ('issued','active')) then raise exception 'Vehicle already has active waybill'; end if;

  select d.license_valid_to into license_valid_to
  from public.drivers d join public.employees e on e.id=d.employee_id
  where d.employee_id=p_driver_id and e.is_active;
  if license_valid_to is null then raise exception 'Driver not found, inactive, or license validity is not configured'; end if;
  if license_valid_to < required_valid_to then raise exception 'Driver license expires before waybill end date'; end if;
  if exists(select 1 from public.waybills w where w.driver_id=p_driver_id and w.status in ('issued','active')) then raise exception 'Driver already has active waybill'; end if;

  if p_trailer_id is not null then
    select * into t from public.vehicles where id=p_trailer_id for update;
    if t.id is null or t.asset_type<>'trailer' then raise exception 'Selected asset is not a trailer'; end if;
    if t.status not in ('operational','reserve') then raise exception 'Trailer is not available for operation'; end if;
    if exists(select 1 from public.waybills w where w.trailer_id=p_trailer_id and w.status in ('issued','active')) then raise exception 'Trailer already has active waybill'; end if;
  end if;

  select r.category into missing_category
  from public.vehicle_license_requirements r
  where r.vehicle_id in (p_vehicle_id,p_trailer_id)
    and not exists(select 1 from public.driver_license_categories c where c.driver_id=p_driver_id and c.category=r.category)
  order by case when r.vehicle_id=p_vehicle_id then 0 else 1 end
  limit 1;
  if missing_category is not null then raise exception 'Driver lacks required license category %',missing_category; end if;

  select * into norm from public.vehicle_fuel_norms where vehicle_id=p_vehicle_id and valid_to is null order by valid_from desc limit 1;
  if v.fuel_type_id is not null and norm.id is null then raise exception 'Current fuel norm is not configured'; end if;
  select id into org_id from public.organizations where is_active order by created_at limit 1;

  select * into last_wb from public.waybills
  where vehicle_id=p_vehicle_id and closing_odometer_km is not null and closing_fuel_l is not null
    and status in ('approved','archived','closed_by_incident')
  order by coalesce(closed_at,valid_to) desc limit 1;

  insert into public.waybills(
    number,vehicle_id,driver_id,organization_id,valid_from,valid_to,status,fuel_norm_id,fuel_norm_snapshot,
    opening_odometer_km,opening_fuel_l,issued_at,issued_by,trailer_id,authorization_text,purpose_text,
    exploitation_group,cargo_name,cargo_mass_t,senior_vehicle_employee_id,responsible_employee_id
  ) values(
    p_number,p_vehicle_id,p_driver_id,org_id,p_valid_from,p_valid_to,'issued',norm.id,norm.rate_l_per_100km,
    coalesce(last_wb.closing_odometer_km,v.current_odometer_km),coalesce(last_wb.closing_fuel_l,v.current_fuel_l),now(),auth.uid(),
    p_trailer_id,nullif(btrim(p_authorization_text),''),nullif(btrim(p_purpose_text),''),nullif(btrim(p_exploitation_group),''),
    nullif(btrim(p_cargo_name),''),p_cargo_mass_t,p_senior_vehicle_employee_id,p_responsible_employee_id
  ) returning id into new_id;

  insert into public.notifications(employee_id,vehicle_id,notification_type,title,body,is_read)
  values(
    p_driver_id,
    p_vehicle_id,
    'waybill_issued',
    format('Выдан ПЛ %s',p_number),
    format(
      'Путевой лист действует с %s по %s. Откройте «Моя машина» и начните работу после проверки стартовых показаний.',
      to_char(p_valid_from at time zone 'Europe/Moscow','DD.MM.YYYY HH24:MI'),
      to_char(p_valid_to at time zone 'Europe/Moscow','DD.MM.YYYY HH24:MI')
    ),
    false
  );

  return new_id;
end;
$function$;

create or replace function private.start_waybill_impl(
  p_waybill_id uuid,
  p_odometer_km numeric,
  p_location_name text,
  p_occurred_at timestamptz,
  p_client_action_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  wb public.waybills%rowtype;
  v public.vehicles%rowtype;
  t public.vehicles%rowtype;
  event_id uuid;
  diff numeric;
  event_time timestamptz;
  missing_category public.license_category;
  license_valid_to date;
  required_valid_to date;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_client_action_id is null then raise exception 'Client action id is required'; end if;
  select * into wb from public.waybills where id=p_waybill_id for update;
  if wb.id is null then raise exception 'Waybill not found'; end if;
  if wb.driver_id is distinct from private.current_employee_id() then raise exception 'Waybill does not belong to current driver'; end if;

  select id into event_id from public.waybill_events where client_action_id=p_client_action_id and waybill_id=p_waybill_id and event_type='start_movement';
  if event_id is not null then return event_id; end if;

  event_time:=coalesce(p_occurred_at,now());
  if wb.status<>'issued' then raise exception 'Waybill must be issued before start'; end if;
  if event_time<wb.valid_from or event_time>=wb.valid_to then raise exception 'Start timestamp is outside waybill validity'; end if;
  if p_odometer_km is null or p_odometer_km<0 then raise exception 'Invalid odometer'; end if;
  if nullif(btrim(p_location_name),'') is null then raise exception 'Start location is required'; end if;

  select * into v from public.vehicles where id=wb.vehicle_id;
  if v.id is null or v.status not in ('operational','reserve') then raise exception 'Vehicle is not available for operation'; end if;
  if wb.trailer_id is not null then
    select * into t from public.vehicles where id=wb.trailer_id;
    if t.id is null or t.status not in ('operational','reserve') then raise exception 'Trailer is not available for operation'; end if;
  end if;

  required_valid_to := (wb.valid_to at time zone 'Europe/Moscow')::date;
  select d.license_valid_to into license_valid_to from public.drivers d join public.employees e on e.id=d.employee_id where d.employee_id=wb.driver_id and e.is_active;
  if license_valid_to is null or license_valid_to<required_valid_to then raise exception 'Driver license expires before waybill end date'; end if;
  select r.category into missing_category
  from public.vehicle_license_requirements r
  where r.vehicle_id in (wb.vehicle_id,wb.trailer_id)
    and not exists(select 1 from public.driver_license_categories c where c.driver_id=wb.driver_id and c.category=r.category)
  limit 1;
  if missing_category is not null then raise exception 'Driver lacks required license category %',missing_category; end if;

  update public.waybills set status='active',updated_at=now() where id=wb.id;
  insert into public.waybill_events(waybill_id,event_type,occurred_at,odometer_km,location_name,source,created_by,client_action_id)
  values(wb.id,'start_movement',event_time,p_odometer_km,btrim(p_location_name),'manual',auth.uid(),p_client_action_id) returning id into event_id;

  update public.notifications
  set is_read=true
  where employee_id=wb.driver_id
    and vehicle_id=wb.vehicle_id
    and notification_type='waybill_issued'
    and title=format('Выдан ПЛ %s',wb.number)
    and not is_read;

  if wb.opening_odometer_km is not null and wb.opening_odometer_km<>p_odometer_km then
    diff:=p_odometer_km-wb.opening_odometer_km;
    insert into public.waybill_reconciliations(waybill_id,issue_type,expected_value,observed_value,difference_value,status)
    values(wb.id,'opening_odometer_mismatch',wb.opening_odometer_km,p_odometer_km,diff,'open')
    on conflict(waybill_id,issue_type) do update set expected_value=excluded.expected_value,observed_value=excluded.observed_value,difference_value=excluded.difference_value,status='open',resolution_text=null,resolved_by=null,resolved_at=null;
    insert into public.notifications(employee_id,vehicle_id,notification_type,title,body)
    values(null,wb.vehicle_id,'odometer_mismatch','Расхождение начального пробега',concat('ПЛ ',wb.number,': ожидалось ',wb.opening_odometer_km,' км, водитель указал ',p_odometer_km,' км. Разница ',diff,' км.'));
  end if;
  return event_id;
end;
$function$;
