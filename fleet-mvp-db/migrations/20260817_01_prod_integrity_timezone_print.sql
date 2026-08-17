begin;

-- One explicit application timezone per organization.
alter table public.organizations
  add column if not exists timezone text not null default 'Europe/Moscow';

create or replace function private.validate_organization_timezone()
returns trigger
language plpgsql
security definer
set search_path to pg_catalog, public, private
as $function$
begin
  if new.timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=new.timezone) then
    raise exception 'Unknown organization timezone: %',coalesce(new.timezone,'NULL');
  end if;
  return new;
end
$function$;
revoke all on function private.validate_organization_timezone() from public,anon,authenticated;

drop trigger if exists organizations_timezone_guard on public.organizations;
create trigger organizations_timezone_guard
before insert or update of timezone on public.organizations
for each row execute function private.validate_organization_timezone();

create or replace function private.fleet_timezone()
returns text
language sql
stable
security definer
set search_path to pg_catalog,public,private
as $function$
  select coalesce((select o.timezone from public.organizations o where o.is_active order by o.created_at,o.id limit 1),'Europe/Moscow'::text);
$function$;
revoke all on function private.fleet_timezone() from public,anon,authenticated;

-- Replace legacy hard-coded fleet timezone literals with the organization setting.
do $block$
declare r record; ddl text;
begin
  for r in
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f'
      and (pg_catalog.pg_get_functiondef(p.oid) like '%Europe/Moscow%' or pg_catalog.pg_get_functiondef(p.oid) like '%Europe/Helsinki%')
      and not (n.nspname='private' and p.proname='fleet_timezone')
  loop
    ddl:=pg_catalog.pg_get_functiondef(r.oid);
    ddl:=replace(ddl,'''Europe/Moscow''','private.fleet_timezone()');
    ddl:=replace(ddl,'''Europe/Helsinki''','private.fleet_timezone()');
    execute ddl;
  end loop;
end
$block$;

create or replace function public.current_fleet_timezone()
returns text
language sql
stable
security invoker
set search_path to pg_catalog,public
as $function$
  select coalesce((select o.timezone from public.organizations o where o.is_active order by o.created_at,o.id limit 1),'Europe/Moscow'::text);
$function$;
revoke all on function public.current_fleet_timezone() from public,anon;
grant execute on function public.current_fleet_timezone() to authenticated;

-- App shell carries the authoritative timezone to clients.
create or replace function public.get_app_shell()
returns jsonb
language plpgsql
security invoker
set search_path to pg_catalog,public,private
as $function$
declare r text; tz text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select role::text into r from public.profiles where id=auth.uid();
  if r is null then raise exception 'Profile not found'; end if;
  tz:=public.current_fleet_timezone();
  if r='admin' then
    return jsonb_build_object(
      'ui_version','app_shell_v2','role','admin','title','Автопарк','timezone',tz,
      'navigation',jsonb_build_array(
        jsonb_build_object('id','home','label','Главная'),
        jsonb_build_object('id','fleet','label','Техника'),
        jsonb_build_object('id','service','label','ТО и ремонт'),
        jsonb_build_object('id','print','label','Печать')
      ),
      'ux_rules',jsonb_build_object('max_main_navigation_items',4,'no_nested_sidebar',true,'show_raw_codes',false,'timezone_source','organization')
    );
  end if;
  return jsonb_build_object(
    'ui_version','app_shell_v2','role','driver','title','Моя машина','timezone',tz,
    'navigation',jsonb_build_array(
      jsonb_build_object('id','work','label','Работа'),
      jsonb_build_object('id','history','label','История')
    ),
    'ux_rules',jsonb_build_object('max_main_navigation_items',2,'no_nested_sidebar',true,'show_raw_codes',false,'timezone_source','organization')
  );
end
$function$;
revoke all on function public.get_app_shell() from public,anon;
grant execute on function public.get_app_shell() to authenticated;

-- Canonical print preflight clearance enum values.
do $block$
declare fn_oid oid; ddl text;
begin
  select p.oid into fn_oid
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_waybill_print_preflight'
    and pg_catalog.pg_get_function_identity_arguments(p.oid)='p_waybill_id uuid';
  if fn_oid is null then raise exception 'get_waybill_print_preflight(uuid) not found'; end if;
  ddl:=pg_catalog.pg_get_functiondef(fn_oid);
  ddl:=replace(ddl,'medical_pretrip','medical_pre');
  ddl:=replace(ddl,'''medical''','''medical_pre''');
  ddl:=replace(ddl,'technical_pretrip','technical_pre');
  ddl:=replace(ddl,'''technical''','''technical_pre''');
  execute ddl;
end
$block$;

-- Historical approvals remain truthful instead of fabricating an approver.
alter table public.waybills add column if not exists approval_source text not null default 'workflow';
alter table public.waybills add column if not exists approval_note text;
update public.waybills
set approval_source='legacy_import',approval_note=coalesce(approval_note,'Imported historical record; original approver is unavailable.')
where status in ('approved','archived') and approved_by is null;

alter table public.waybills drop constraint if exists waybills_approval_source_check;
alter table public.waybills add constraint waybills_approval_source_check
  check(approval_source in ('workflow','legacy_import'));
alter table public.waybills drop constraint if exists waybills_approval_provenance_check;
alter table public.waybills add constraint waybills_approval_provenance_check
  check(status not in ('approved','archived') or (
    approved_at is not null and (
      (approval_source='workflow' and approved_by is not null)
      or (approval_source='legacy_import' and approval_note is not null)
    )
  ));

-- New workflow approvals always replace legacy-import provenance.
do $block$
declare fn_oid oid; ddl text;
begin
  select p.oid into fn_oid
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname='approve_waybill_impl'
    and pg_catalog.pg_get_function_identity_arguments(p.oid)='p_waybill_id uuid';
  if fn_oid is null then raise exception 'private.approve_waybill_impl(uuid) not found'; end if;
  ddl:=pg_catalog.pg_get_functiondef(fn_oid);
  if ddl not like '%set status=''approved'',approved_at=now(),approved_by=auth.uid(),updated_at=now()%' then
    raise exception 'approve_waybill_impl update shape changed; refusing blind patch';
  end if;
  ddl:=replace(ddl,
    'set status=''approved'',approved_at=now(),approved_by=auth.uid(),updated_at=now()',
    'set status=''approved'',approved_at=now(),approved_by=auth.uid(),approval_source=''workflow'',approval_note=null,updated_at=now()');
  execute ddl;
end
$block$;

-- Temporal integrity is enforced by PostgreSQL, not only RPC code.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
do $block$
begin
  if exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='btree_gist' and n.nspname='public') then
    alter extension btree_gist set schema extensions;
  end if;
end
$block$;

alter table public.waybills drop constraint if exists waybills_driver_validity_no_overlap;
alter table public.waybills add constraint waybills_driver_validity_no_overlap
  exclude using gist(driver_id with =,tstzrange(valid_from,valid_to,'[)') with &&)
  where(status<>'draft'::public.waybill_status);
alter table public.waybills drop constraint if exists waybills_vehicle_validity_no_overlap;
alter table public.waybills add constraint waybills_vehicle_validity_no_overlap
  exclude using gist(vehicle_id with =,tstzrange(valid_from,valid_to,'[)') with &&)
  where(status<>'draft'::public.waybill_status);
alter table public.waybills drop constraint if exists waybills_trailer_validity_no_overlap;
alter table public.waybills add constraint waybills_trailer_validity_no_overlap
  exclude using gist(trailer_id with =,tstzrange(valid_from,valid_to,'[)') with &&)
  where(trailer_id is not null and status<>'draft'::public.waybill_status);

-- Expired periods cannot stay in the current-open state.
update public.reporting_periods set status='under_review' where status='open' and period_end<=now();

-- Preserve legacy print-module labels only at the print API boundary.
do $block$
declare
  fn_oid oid; ddl text;
  old_expr text := '''clearances'',coalesce((select jsonb_agg(to_jsonb(c) order by c.checked_at,c.clearance_type::text) from public.v_waybill_clearances_print c where c.waybill_id=p_waybill_id),''[]''::jsonb)';
  new_expr text := '''clearances'',coalesce((select jsonb_agg(jsonb_set(to_jsonb(c),''{clearance_type}'',to_jsonb(case c.clearance_type::text when ''medical_pre'' then ''medical_pretrip'' when ''medical_post'' then ''medical_posttrip'' when ''technical_pre'' then ''technical_pretrip'' when ''technical_post'' then ''technical_posttrip'' else c.clearance_type::text end),false) order by c.checked_at,c.clearance_type::text) from public.v_waybill_clearances_print c where c.waybill_id=p_waybill_id),''[]''::jsonb)';
begin
  select p.oid into fn_oid
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_waybill_print_package'
    and pg_catalog.pg_get_function_identity_arguments(p.oid)='p_waybill_id uuid';
  if fn_oid is null then raise exception 'get_waybill_print_package(uuid) not found'; end if;
  ddl:=pg_catalog.pg_get_functiondef(fn_oid);
  if position(old_expr in ddl)=0 then raise exception 'get_waybill_print_package clearance expression changed; refusing blind patch'; end if;
  ddl:=replace(ddl,old_expr,new_expr);
  execute ddl;
end
$block$;

commit;
