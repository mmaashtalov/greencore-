-- Fleet MVP driver/vehicle assignment invariant.
-- Applied to Supabase project: fleet-mvp (tikjmiyrhkcjrxjylmqb)
-- Server-side assignment now rejects trailers, terminal vehicle states, inactive
-- or expired drivers, and category mismatches even if a client bypasses UI filters.

create or replace function public.assign_driver_vehicle(
  p_driver_id uuid,
  p_vehicle_id uuid,
  p_is_primary boolean default true
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  missing public.license_category;
  v_profile uuid;
  assignment_id uuid;
  v public.vehicles%rowtype;
  license_valid_to date;
  today_moscow date := (now() at time zone 'Europe/Moscow')::date;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;

  select * into v
  from public.vehicles
  where id=p_vehicle_id;

  if v.id is null then raise exception 'Vehicle not found'; end if;
  if v.asset_type <> 'self_propelled' then
    raise exception 'Driver cannot be assigned to a trailer';
  end if;
  if v.status in ('destroyed','written_off') then
    raise exception 'Vehicle is not available for assignment';
  end if;

  select d.license_valid_to into license_valid_to
  from public.drivers d
  join public.employees e on e.id=d.employee_id
  where d.employee_id=p_driver_id and e.is_active;

  if license_valid_to is null then
    raise exception 'Driver not found, inactive, or license validity is not configured';
  end if;
  if license_valid_to < today_moscow then
    raise exception 'Driver license has expired';
  end if;

  select r.category into missing
  from public.vehicle_license_requirements r
  where r.vehicle_id=p_vehicle_id
    and not exists(
      select 1
      from public.driver_license_categories c
      where c.driver_id=p_driver_id and c.category=r.category
    )
  limit 1;

  if missing is not null then
    raise exception 'Driver lacks required category %',missing;
  end if;

  select id into v_profile
  from public.profiles
  where id=auth.uid();

  update public.vehicle_assignments
  set valid_to=now()
  where valid_to is null
    and (driver_id=p_driver_id or vehicle_id=p_vehicle_id);

  insert into public.vehicle_assignments(driver_id,vehicle_id,is_primary,assigned_by)
  values(p_driver_id,p_vehicle_id,coalesce(p_is_primary,true),v_profile)
  returning id into assignment_id;

  return assignment_id;
end
$function$;
