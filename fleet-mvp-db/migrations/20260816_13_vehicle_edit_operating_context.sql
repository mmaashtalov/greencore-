-- Expose read-only operating context to the vehicle edit UI.
-- This lets the client prevent tank capacity from being saved below the live fuel remainder
-- without making odometer/fuel directly editable.

create or replace function private.get_vehicle_edit_form_impl(p_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private'
as $function$
declare v public.vehicles%rowtype; begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into v from public.vehicles where id=p_vehicle_id; if v.id is null then raise exception 'Vehicle not found'; end if;
  return jsonb_build_object(
    'ui_version','vehicle_edit_v2',
    'title','Редактировать технику',
    'values',jsonb_build_object(
      'registration_number',v.registration_number,'make',v.make,'model',v.model,
      'tank_capacity_l',v.tank_capacity_l,'vin',v.vin,'purpose',v.purpose,
      'required_categories',coalesce((select jsonb_agg(r.category order by r.category) from public.vehicle_license_requirements r where r.vehicle_id=v.id),'[]'::jsonb)
    ),
    'operating_context',jsonb_build_object(
      'asset_type',v.asset_type,
      'current_fuel_l',case when v.asset_type='self_propelled' then v.current_fuel_l else null end,
      'current_odometer_km',case when v.asset_type='self_propelled' then v.current_odometer_km else null end
    ),
    'main_fields',jsonb_build_array('make','model','registration_number','required_categories'),
    'optional_fields',jsonb_build_array('tank_capacity_l','vin','purpose'),
    'locked_fields',jsonb_build_array('internal_number','vehicle_class','fuel_type','current_odometer_km','current_fuel_l'),
    'locked_hint','Пробег, топливо и тип техники меняются только через профильные операции учета.',
    'primary_action',jsonb_build_object('id','save','label','Сохранить','enabled',true),
    'secondary_actions',case when v.asset_type='self_propelled' then jsonb_build_array(jsonb_build_object('id','fuel_norm','label','Изменить норму топлива','enabled',true)) else '[]'::jsonb end,
    'ux_rules',jsonb_build_object('one_primary_action',true,'optional_collapsed',true,'protect_operational_state',true,'tank_not_below_current_fuel',true)
  );
end
$function$;
