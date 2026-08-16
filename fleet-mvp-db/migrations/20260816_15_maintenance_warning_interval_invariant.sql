create or replace function public.create_maintenance_rule(p_vehicle_id uuid, p_item_name text, p_interval_km numeric, p_interval_days integer, p_warning_km numeric, p_warning_days integer, p_notes text)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare new_id uuid; v public.vehicles%rowtype;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Действие доступно только администратору'; end if;
  select * into v from public.vehicles where id=p_vehicle_id;
  if v.id is null or v.asset_type<>'self_propelled' then raise exception 'Регламент ТО можно задать только для самоходной техники'; end if;
  if nullif(btrim(p_item_name),'') is null then raise exception 'Укажите вид обслуживания'; end if;
  if coalesce(p_interval_km,0)<=0 and coalesce(p_interval_days,0)<=0 then raise exception 'Укажите интервал по пробегу или по времени'; end if;
  if p_interval_km is not null and p_interval_km<=0 then raise exception 'Интервал по пробегу должен быть больше нуля'; end if;
  if p_interval_days is not null and p_interval_days<=0 then raise exception 'Интервал по дням должен быть больше нуля'; end if;
  if p_warning_km is not null and p_interval_km is null then raise exception 'Порог предупреждения по пробегу требует интервал по пробегу'; end if;
  if p_warning_days is not null and p_interval_days is null then raise exception 'Порог предупреждения по дням требует интервал по дням'; end if;
  if p_warning_km is not null and (p_warning_km<0 or p_warning_km>=p_interval_km) then raise exception 'Порог предупреждения по пробегу должен быть меньше интервала'; end if;
  if p_warning_days is not null and (p_warning_days<0 or p_warning_days>=p_interval_days) then raise exception 'Порог предупреждения по дням должен быть меньше интервала'; end if;
  insert into public.maintenance_rules(vehicle_id,item_name,interval_km,interval_days,warning_km,warning_days,notes,is_active)
  values(p_vehicle_id,btrim(p_item_name),p_interval_km,p_interval_days,p_warning_km,p_warning_days,nullif(btrim(p_notes),''),true)
  returning id into new_id;
  return new_id;
end $function$;

create or replace function public.update_maintenance_rule(p_rule_id uuid, p_item_name text, p_interval_km numeric, p_interval_days integer, p_warning_km numeric, p_warning_days integer, p_notes text)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Действие доступно только администратору'; end if;
  if nullif(btrim(p_item_name),'') is null then raise exception 'Укажите вид обслуживания'; end if;
  if coalesce(p_interval_km,0)<=0 and coalesce(p_interval_days,0)<=0 then raise exception 'Укажите интервал по пробегу или по времени'; end if;
  if p_interval_km is not null and p_interval_km<=0 then raise exception 'Интервал по пробегу должен быть больше нуля'; end if;
  if p_interval_days is not null and p_interval_days<=0 then raise exception 'Интервал по дням должен быть больше нуля'; end if;
  if p_warning_km is not null and p_interval_km is null then raise exception 'Порог предупреждения по пробегу требует интервал по пробегу'; end if;
  if p_warning_days is not null and p_interval_days is null then raise exception 'Порог предупреждения по дням требует интервал по дням'; end if;
  if p_warning_km is not null and (p_warning_km<0 or p_warning_km>=p_interval_km) then raise exception 'Порог предупреждения по пробегу должен быть меньше интервала'; end if;
  if p_warning_days is not null and (p_warning_days<0 or p_warning_days>=p_interval_days) then raise exception 'Порог предупреждения по дням должен быть меньше интервала'; end if;
  update public.maintenance_rules set item_name=btrim(p_item_name),interval_km=p_interval_km,interval_days=p_interval_days,warning_km=p_warning_km,warning_days=p_warning_days,notes=nullif(btrim(p_notes),'') where id=p_rule_id and is_active;
  if not found then raise exception 'Регламент ТО не найден'; end if;
end $function$;