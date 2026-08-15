-- Fleet MVP driver creation invariant.
-- Applied to Supabase project: fleet-mvp (tikjmiyrhkcjrxjylmqb)
-- A newly created active driver must already have at least one category and a
-- non-expired license validity date; otherwise the driver cannot receive a waybill.

create or replace function private.create_driver_simple_impl(
  p_full_name text,
  p_categories public.license_category[],
  p_rank_title text default null::text,
  p_license_valid_to date default null::date,
  p_license_number text default null::text,
  p_phone text default null::text
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  v_id uuid;
  c public.license_category;
  today_moscow date := (now() at time zone 'Europe/Moscow')::date;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;
  if nullif(btrim(p_full_name),'') is null then
    raise exception 'Full name required';
  end if;
  if coalesce(array_length(p_categories,1),0)=0 then
    raise exception 'At least one license category required';
  end if;
  if p_license_valid_to is null then
    raise exception 'Driver license validity date is required';
  end if;
  if p_license_valid_to < today_moscow then
    raise exception 'Driver license has expired';
  end if;
  if exists(
    select 1
    from public.employees e
    join public.drivers d on d.employee_id=e.id
    where e.is_active and lower(btrim(e.full_name))=lower(btrim(p_full_name))
  ) then
    raise exception 'Active driver with this name already exists';
  end if;

  insert into public.employees(full_name,phone,is_active,rank_title,position_title)
  values(btrim(p_full_name),nullif(btrim(p_phone),''),true,nullif(btrim(p_rank_title),''),'водитель')
  returning id into v_id;

  insert into public.drivers(employee_id,license_number,license_valid_to)
  values(v_id,nullif(btrim(p_license_number),''),p_license_valid_to);

  foreach c in array p_categories loop
    insert into public.driver_license_categories(driver_id,category)
    values(v_id,c)
    on conflict do nothing;
  end loop;

  return v_id;
end
$function$;
