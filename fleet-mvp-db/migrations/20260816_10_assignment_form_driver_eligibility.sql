-- Keep assignment UI eligibility aligned with assignment backend guards.
-- Active drivers must have a license valid on the current Moscow calendar date.

create or replace function private.get_assignment_form_impl(p_vehicle_id uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare
  v public.vehicles%rowtype;
  busy_wb record;
  current_driver record;
  vehicle_blocked boolean:=false;
  today_msk date:=(now() at time zone 'Europe/Moscow')::date;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;

  if p_vehicle_id is not null then
    select * into v from public.vehicles where id=p_vehicle_id;
    if v.id is null then raise exception 'Vehicle not found'; end if;
    if v.asset_type<>'self_propelled' then raise exception 'Driver is assigned to self-propelled vehicle'; end if;

    select w.id,w.number,w.driver_id,w.status::text status,e.full_name driver_name
      into busy_wb
    from public.waybills w
    join public.employees e on e.id=w.driver_id
    where w.vehicle_id=v.id
      and w.status in ('issued','active','closed_by_driver','under_review','needs_correction')
    order by w.valid_from desc limit 1;
    vehicle_blocked:=busy_wb.id is not null;

    select a.driver_id,e.full_name,vv.id vehicle_id,vv.make||' '||vv.model||' №'||vv.internal_number vehicle
      into current_driver
    from public.vehicle_assignments a
    join public.employees e on e.id=a.driver_id
    join public.vehicles vv on vv.id=a.vehicle_id
    where a.vehicle_id=v.id and a.valid_to is null and a.is_primary
    order by a.valid_from desc limit 1;
  end if;

  return jsonb_build_object(
    'ui_version','assignment_v3',
    'title','Закрепить водителя',
    'subtitle','Показываем только водителей с нужной категорией, действующим удостоверением и без незавершенного ПЛ на другой машине.',
    'selected_vehicle',case when v.id is null then null else jsonb_build_object(
      'id',v.id,'label',v.make||' '||v.model||' №'||v.internal_number,
      'status_label',case v.status when 'operational' then 'В эксплуатации' when 'reserve' then 'Резерв' when 'maintenance' then 'На ТО' when 'repair' then 'В ремонте' else 'Недоступна' end,
      'required_categories',coalesce((select jsonb_agg(r.category order by r.category::text) from public.vehicle_license_requirements r where r.vehicle_id=v.id),'[]'::jsonb),
      'current_driver',case when current_driver.driver_id is null then null else jsonb_build_object('id',current_driver.driver_id,'label',current_driver.full_name) end,
      'assignment_blocked',vehicle_blocked,
      'blocking_waybill',case when busy_wb.id is null then null else jsonb_build_object('id',busy_wb.id,'number',busy_wb.number,'driver_id',busy_wb.driver_id,'driver',busy_wb.driver_name,'status',busy_wb.status) end
    ) end,
    'vehicles',case when v.id is not null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',x.id,'label',x.make||' '||x.model||' №'||x.internal_number,
        'status_label',case x.status when 'operational' then 'В эксплуатации' when 'reserve' then 'Резерв' when 'maintenance' then 'На ТО' when 'repair' then 'В ремонте' else 'Недоступна' end,
        'assignment_blocked',exists(select 1 from public.waybills w where w.vehicle_id=x.id and w.status in ('issued','active','closed_by_driver','under_review','needs_correction'))
      ) order by x.internal_number)
      from public.vehicles x
      where x.asset_type='self_propelled' and x.status not in ('destroyed','written_off')
    ),'[]'::jsonb) end,
    'drivers',case when v.id is null or vehicle_blocked then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',e.id,'label',e.full_name,'rank',e.rank_title,
        'license_valid_to',d.license_valid_to,
        'categories',coalesce(c.categories,'[]'::jsonb),
        'currently_assigned',a.vehicle,
        'currently_assigned_vehicle_id',a.vehicle_id,
        'same_vehicle',a.vehicle_id=v.id
      ) order by (a.vehicle_id=v.id) desc,e.full_name)
      from public.drivers d
      join public.employees e on e.id=d.employee_id
      left join lateral (
        select jsonb_agg(x.category order by x.category::text) categories
        from public.driver_license_categories x where x.driver_id=e.id
      ) c on true
      left join lateral (
        select vv.id vehicle_id,vv.make||' '||vv.model||' №'||vv.internal_number vehicle
        from public.vehicle_assignments va
        join public.vehicles vv on vv.id=va.vehicle_id
        where va.driver_id=e.id and va.valid_to is null and va.is_primary
        order by va.valid_from desc limit 1
      ) a on true
      where e.is_active
        and d.license_valid_to is not null
        and d.license_valid_to>=today_msk
        and not exists(
          select 1 from public.vehicle_license_requirements r
          where r.vehicle_id=v.id
            and not exists(select 1 from public.driver_license_categories dc where dc.driver_id=e.id and dc.category=r.category)
        )
        and not exists(
          select 1 from public.waybills w
          where w.driver_id=e.id
            and w.vehicle_id<>v.id
            and w.status in ('issued','active','closed_by_driver','under_review','needs_correction')
        )
    ),'[]'::jsonb) end,
    'primary_action',jsonb_build_object(
      'id','assign','label',case when vehicle_blocked then 'Закрепление недоступно' else 'Закрепить' end,
      'enabled',v.id is not null and not vehicle_blocked
    ),
    'blocking_message',case when vehicle_blocked then 'Сначала завершите ПЛ '||busy_wb.number||' ('||busy_wb.driver_name||').' else null end,
    'ux_rules',jsonb_build_object(
      'two_step',true,'filter_incompatible_drivers',true,'filter_expired_drivers',true,'hide_busy_drivers',true,
      'block_reassignment_during_unfinished_waybill',true,'warn_before_moving_existing_assignment',true,
      'one_primary_action',true,'show_license_details',false
    )
  );
end
$function$;
