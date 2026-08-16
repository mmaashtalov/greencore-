create or replace function public.get_maintenance_event_correction_ui(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  e public.maintenance_events%rowtype;
  r public.maintenance_rules%rowtype;
  v public.vehicles%rowtype;
  p public.maintenance_events%rowtype;
  n public.maintenance_events%rowtype;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into e from public.maintenance_events where id=p_event_id and status='completed';
  if e.id is null then raise exception 'Completed maintenance event not found'; end if;
  select * into r from public.maintenance_rules where id=e.maintenance_rule_id;
  select * into v from public.vehicles where id=e.vehicle_id;
  if r.id is null or v.id is null then raise exception 'Maintenance context not found'; end if;

  select * into p from public.maintenance_events x
   where x.maintenance_rule_id=e.maintenance_rule_id and x.status='completed' and x.id<>e.id
     and (x.performed_at,x.id)<(e.performed_at,e.id)
   order by x.performed_at desc,x.id desc limit 1;
  select * into n from public.maintenance_events x
   where x.maintenance_rule_id=e.maintenance_rule_id and x.status='completed' and x.id<>e.id
     and (x.performed_at,x.id)>(e.performed_at,e.id)
   order by x.performed_at,x.id limit 1;

  return jsonb_build_object(
    'ui_version','maintenance_event_correction_v1',
    'event',jsonb_build_object(
      'id',e.id,'performed_at',e.performed_at,'odometer_km',e.odometer_km,
      'description',e.description,'cost_amount',e.cost_amount
    ),
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,'')),'current_odometer_km',v.current_odometer_km),
    'rule',jsonb_build_object('id',r.id,'item_name',r.item_name),
    'limits',jsonb_build_object(
      'performed_at_min',p.performed_at,
      'performed_at_max',coalesce(n.performed_at,now()),
      'odometer_min',p.odometer_km,
      'odometer_max',coalesce(n.odometer_km,v.current_odometer_km),
      'reason_min_chars',5
    ),
    'neighbors',jsonb_build_object(
      'previous',case when p.id is null then null else jsonb_build_object('id',p.id,'performed_at',p.performed_at,'odometer_km',p.odometer_km) end,
      'next',case when n.id is null then null else jsonb_build_object('id',n.id,'performed_at',n.performed_at,'odometer_km',n.odometer_km) end
    ),
    'ux_rules',jsonb_build_object('empty_cost_means_unknown',true,'explicit_zero_cost_is_valid',true,'reason_required',true)
  );
end;
$function$;

create or replace function public.correct_maintenance_event(
  p_event_id uuid,
  p_odometer_km numeric,
  p_performed_at timestamptz,
  p_description text,
  p_cost_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  e public.maintenance_events%rowtype;
  v public.vehicles%rowtype;
  p public.maintenance_events%rowtype;
  n public.maintenance_events%rowtype;
  v_reason text;
  v_description text;
  v_before jsonb;
  v_after jsonb;
  v_audit_before bigint;
  v_audit_id bigint;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into e from public.maintenance_events where id=p_event_id and status='completed' for update;
  if e.id is null then raise exception 'Completed maintenance event not found'; end if;
  select * into v from public.vehicles where id=e.vehicle_id for update;
  if v.id is null then raise exception 'Vehicle not found'; end if;

  v_reason:=nullif(btrim(p_reason),'');
  if v_reason is null or char_length(v_reason)<5 then raise exception 'Correction reason must contain at least 5 characters'; end if;
  if p_odometer_km is null or p_odometer_km<0 then raise exception 'Odometer is required'; end if;
  if p_performed_at is null then raise exception 'Maintenance date is required'; end if;
  if p_performed_at>now()+interval '5 minutes' then raise exception 'Maintenance date cannot be in the future'; end if;
  if p_cost_amount is not null and p_cost_amount<0 then raise exception 'Cost cannot be negative'; end if;
  v_description:=nullif(btrim(p_description),'');
  if v_description is null then raise exception 'Maintenance description is required'; end if;
  if v.current_odometer_km is not null and p_odometer_km>v.current_odometer_km then raise exception 'Maintenance odometer cannot exceed current vehicle odometer'; end if;

  select * into p from public.maintenance_events x
   where x.maintenance_rule_id=e.maintenance_rule_id and x.status='completed' and x.id<>e.id
     and (x.performed_at,x.id)<(e.performed_at,e.id)
   order by x.performed_at desc,x.id desc limit 1;
  select * into n from public.maintenance_events x
   where x.maintenance_rule_id=e.maintenance_rule_id and x.status='completed' and x.id<>e.id
     and (x.performed_at,x.id)>(e.performed_at,e.id)
   order by x.performed_at,x.id limit 1;

  if p.id is not null then
    if p_performed_at<=p.performed_at then raise exception 'Maintenance date must be later than the previous service'; end if;
    if p.odometer_km is not null and p_odometer_km<p.odometer_km then raise exception 'Maintenance odometer cannot be below the previous service'; end if;
  end if;
  if n.id is not null then
    if p_performed_at>=n.performed_at then raise exception 'Maintenance date must be earlier than the next service'; end if;
    if n.odometer_km is not null and p_odometer_km>n.odometer_km then raise exception 'Maintenance odometer cannot exceed the next service'; end if;
  end if;

  v_before:=jsonb_build_object('performed_at',e.performed_at,'odometer_km',e.odometer_km,'description',e.description,'cost_amount',e.cost_amount);
  v_after:=jsonb_build_object('performed_at',p_performed_at,'odometer_km',p_odometer_km,'description',v_description,'cost_amount',p_cost_amount);
  if v_before=v_after then raise exception 'No changes to save'; end if;

  select coalesce(max(id),0) into v_audit_before from public.audit_log;
  update public.maintenance_events
     set performed_at=p_performed_at,odometer_km=p_odometer_km,description=v_description,cost_amount=p_cost_amount
   where id=e.id;

  select id into v_audit_id from public.audit_log
   where id>v_audit_before and entity_type='maintenance_events' and entity_id=e.id and action='update' and actor_profile_id=auth.uid()
   order by id desc limit 1;
  if v_audit_id is null then raise exception 'Maintenance correction audit entry was not created'; end if;
  update public.audit_log set reason=v_reason where id=v_audit_id;

  return jsonb_build_object('id',e.id,'changed',true,'audit_id',v_audit_id);
end;
$function$;

revoke all on function public.get_maintenance_event_correction_ui(uuid) from public;
revoke all on function public.get_maintenance_event_correction_ui(uuid) from anon;
grant execute on function public.get_maintenance_event_correction_ui(uuid) to authenticated;
revoke all on function public.correct_maintenance_event(uuid,numeric,timestamptz,text,numeric,text) from public;
revoke all on function public.correct_maintenance_event(uuid,numeric,timestamptz,text,numeric,text) from anon;
grant execute on function public.correct_maintenance_event(uuid,numeric,timestamptz,text,numeric,text) to authenticated;
