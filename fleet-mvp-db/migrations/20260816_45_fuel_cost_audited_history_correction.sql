create table if not exists private.fuel_transaction_changes(
  id uuid primary key default gen_random_uuid(),
  fuel_transaction_id uuid not null references public.fuel_transactions(id) on delete restrict,
  vehicle_id uuid not null references public.vehicles(id) on delete restrict,
  waybill_id uuid not null references public.waybills(id) on delete restrict,
  changed_at timestamptz not null default now(),
  changed_by uuid references public.profiles(id) on delete set null,
  reason text not null,
  before_data jsonb not null,
  after_data jsonb not null
);

create index if not exists fuel_transaction_changes_tx_idx
  on private.fuel_transaction_changes(fuel_transaction_id,changed_at desc);
create index if not exists fuel_transaction_changes_vehicle_idx
  on private.fuel_transaction_changes(vehicle_id,changed_at desc);

revoke all on table private.fuel_transaction_changes from public,anon,authenticated;

create or replace function public.get_vehicle_fuel_cost_correction_ui(p_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  v public.vehicles%rowtype;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into v from public.vehicles where id=p_vehicle_id;
  if v.id is null then raise exception 'Vehicle not found'; end if;

  return jsonb_build_object(
    'ui_version','fuel_cost_history_correction_v1',
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,''))),
    'summary',jsonb_build_object(
      'transaction_count',(select count(*)::int from public.fuel_transactions ft join public.waybills wb on wb.id=ft.waybill_id where ft.vehicle_id=v.id and wb.status::text in ('approved','archived','closed_by_incident')),
      'priced_count',(select count(*)::int from public.fuel_transactions ft join public.waybills wb on wb.id=ft.waybill_id where ft.vehicle_id=v.id and wb.status::text in ('approved','archived','closed_by_incident') and ft.cost_amount is not null),
      'missing_cost_count',(select count(*)::int from public.fuel_transactions ft join public.waybills wb on wb.id=ft.waybill_id where ft.vehicle_id=v.id and wb.status::text in ('approved','archived','closed_by_incident') and ft.cost_amount is null),
      'recorded_cost',(select coalesce(sum(ft.cost_amount),0) from public.fuel_transactions ft join public.waybills wb on wb.id=ft.waybill_id where ft.vehicle_id=v.id and wb.status::text in ('approved','archived','closed_by_incident') and ft.cost_amount is not null)
    ),
    'items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',q.id,'waybill_id',q.waybill_id,'waybill_number',q.number,'waybill_status',q.status,
        'occurred_at',q.occurred_at,'quantity_l',q.quantity_l,'odometer_km',q.odometer_km,
        'cost_amount',q.cost_amount,'cost_missing',q.cost_amount is null,
        'change_count',(select count(*)::int from private.fuel_transaction_changes c where c.fuel_transaction_id=q.id)
      ) order by (q.cost_amount is null) desc,q.occurred_at desc)
      from (
        select ft.id,ft.waybill_id,wb.number,wb.status::text status,ft.occurred_at,ft.quantity_l,ft.odometer_km,ft.cost_amount
        from public.fuel_transactions ft
        join public.waybills wb on wb.id=ft.waybill_id
        where ft.vehicle_id=v.id and wb.status::text in ('approved','archived','closed_by_incident')
        order by (ft.cost_amount is null) desc,ft.occurred_at desc
        limit 80
      ) q
    ),'[]'::jsonb),
    'ux_rules',jsonb_build_object(
      'editable_field','cost_amount','reason_required',true,'reason_min_chars',5,'reason_max_chars',300,
      'null_cost_means_unknown',true,'explicit_zero_cost_is_valid',true,
      'quantity_odometer_time_immutable',true,'finalized_waybill_only',true,'max_rows',80
    )
  );
end
$function$;

create or replace function public.correct_fuel_transaction_cost(
  p_transaction_id uuid,
  p_cost_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  ft public.fuel_transactions%rowtype;
  wb public.waybills%rowtype;
  v_reason text;
  v_before jsonb;
  v_after jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into ft from public.fuel_transactions where id=p_transaction_id for update;
  if ft.id is null then raise exception 'Fuel transaction not found'; end if;
  select * into wb from public.waybills where id=ft.waybill_id for update;
  if wb.id is null then raise exception 'Waybill not found'; end if;
  if wb.status::text not in ('approved','archived','closed_by_incident') then
    raise exception 'Fuel cost history can be corrected only after waybill finalization';
  end if;
  if p_cost_amount is not null and p_cost_amount<0 then raise exception 'Refuel cost cannot be negative'; end if;
  v_reason:=nullif(btrim(p_reason),'');
  if v_reason is null or char_length(v_reason)<5 then raise exception 'Correction reason must contain at least 5 characters'; end if;
  if ft.cost_amount is not distinct from p_cost_amount then raise exception 'No changes to save'; end if;

  v_before:=jsonb_build_object('cost_amount',ft.cost_amount,'quantity_l',ft.quantity_l,'odometer_km',ft.odometer_km,'occurred_at',ft.occurred_at);
  v_after:=jsonb_build_object('cost_amount',p_cost_amount,'quantity_l',ft.quantity_l,'odometer_km',ft.odometer_km,'occurred_at',ft.occurred_at);

  update public.fuel_transactions set cost_amount=p_cost_amount where id=ft.id;
  insert into private.fuel_transaction_changes(fuel_transaction_id,vehicle_id,waybill_id,changed_by,reason,before_data,after_data)
  values(ft.id,ft.vehicle_id,ft.waybill_id,auth.uid(),v_reason,v_before,v_after);

  return jsonb_build_object('id',ft.id,'changed',true,'cost_amount',p_cost_amount,'changed_at',now());
end
$function$;

revoke all on function public.get_vehicle_fuel_cost_correction_ui(uuid) from public,anon;
grant execute on function public.get_vehicle_fuel_cost_correction_ui(uuid) to authenticated;
revoke all on function public.correct_fuel_transaction_cost(uuid,numeric,text) from public,anon;
grant execute on function public.correct_fuel_transaction_cost(uuid,numeric,text) to authenticated;
