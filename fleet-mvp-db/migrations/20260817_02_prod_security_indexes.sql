begin;

-- Foreign-key support indexes for hot audit/history paths.
create index if not exists fuel_transaction_changes_changed_by_idx on private.fuel_transaction_changes(changed_by);
create index if not exists fuel_transaction_changes_waybill_idx on private.fuel_transaction_changes(waybill_id);
create index if not exists incident_evidence_voids_voided_by_idx on private.incident_evidence_voids(voided_by);
create index if not exists repair_preventive_followups_cancelled_by_idx on private.repair_preventive_followups(cancelled_by);
create index if not exists repair_preventive_followups_completed_by_idx on private.repair_preventive_followups(completed_by);
create index if not exists repair_preventive_followups_created_by_idx on private.repair_preventive_followups(created_by);
create index if not exists repair_work_item_changes_changed_by_idx on private.repair_work_item_changes(changed_by);
create index if not exists repair_work_item_changes_repair_case_idx on private.repair_work_item_changes(repair_case_id);
create index if not exists repair_work_item_changes_work_item_idx on private.repair_work_item_changes(work_item_id);
create index if not exists repair_work_items_recorded_by_idx on public.repair_work_items(recorded_by);
create index if not exists repair_work_items_updated_by_idx on public.repair_work_items(updated_by);

-- Thin public RPC delegators do not need definer privileges.
do $block$
declare r record;
begin
  for r in
    select p.oid,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.prosecdef
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
      and position('private.' in lower(p.prosrc))>0
      and position('auth.uid' in lower(p.prosrc))=0
      and position('is_admin' in lower(p.prosrc))=0
      and position('current_employee_id' in lower(p.prosrc))=0
  loop
    execute format('alter function %I.%I(%s) security invoker',r.nspname,r.proname,r.args);
  end loop;
end
$block$;

-- Private is an implementation schema, never an anonymous API surface.
revoke all on schema private from public,anon;
grant usage on schema private to authenticated;
revoke all on all functions in schema private from public,anon,authenticated;

-- Re-grant only private entry points referenced by authenticated invoker RPCs.
do $block$
declare r record;
begin
  for r in
    with invoker_api as (
      select p.prosrc
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and not p.prosecdef
        and has_function_privilege('authenticated',p.oid,'EXECUTE')
        and position('private.' in lower(p.prosrc))>0
    ), referenced_names as (
      select distinct m[1] as proname
      from invoker_api a
      cross join lateral regexp_matches(a.prosrc,'private\.([A-Za-z0-9_]+)\s*\(','g') m
    )
    select q.oid,n.nspname,q.proname,pg_get_function_identity_arguments(q.oid) as args
    from referenced_names x
    join pg_proc q on q.proname=x.proname
    join pg_namespace n on n.oid=q.pronamespace and n.nspname='private'
    where q.prokind='f'
  loop
    execute format('grant execute on function %I.%I(%s) to authenticated',r.nspname,r.proname,r.args);
  end loop;
end
$block$;

-- Move all remaining authenticated SECURITY DEFINER API implementations out of
-- the exposed public schema. Preserve exact public names/signatures as invoker wrappers.
do $block$
declare
  r record; arg_call text; wrapper_sql text; volatility text;
begin
  for r in
    select p.oid,p.proname,
           pg_get_function_identity_arguments(p.oid) as identity_args,
           pg_get_function_arguments(p.oid) as full_args,
           pg_get_function_result(p.oid) as result_type,
           p.proargnames,p.pronargs,p.provolatile,p.proretset
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.prosecdef
      and has_function_privilege('authenticated',p.oid,'EXECUTE')
    order by p.proname,pg_get_function_identity_arguments(p.oid)
  loop
    if exists(
      select 1 from pg_proc q join pg_namespace nq on nq.oid=q.pronamespace
      where nq.nspname='private' and q.proname=r.proname
        and pg_get_function_identity_arguments(q.oid)=r.identity_args
    ) then
      raise exception 'Private function conflict for private.%(%)',r.proname,r.identity_args;
    end if;
    if r.pronargs>0 and (r.proargnames is null or array_length(r.proargnames,1)<r.pronargs) then
      raise exception 'Cannot preserve unnamed RPC arguments for %(%)',r.proname,r.identity_args;
    end if;

    arg_call:='';
    if r.pronargs>0 then
      select string_agg(format('%I',r.proargnames[i]),', ' order by i)
      into arg_call
      from generate_series(1,r.pronargs) g(i);
    end if;

    execute format('alter function public.%I(%s) set schema private',r.proname,r.identity_args);
    volatility:=case r.provolatile when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end;
    wrapper_sql:=format(
      'create function public.%I(%s) returns %s language sql %s security invoker set search_path to pg_catalog, public, private as $rpc$ select private.%I(%s); $rpc$',
      r.proname,r.full_args,r.result_type,volatility,r.proname,arg_call
    );
    execute wrapper_sql;
    execute format('revoke all on function public.%I(%s) from public,anon',r.proname,r.identity_args);
    execute format('grant execute on function public.%I(%s) to authenticated',r.proname,r.identity_args);
    execute format('revoke all on function private.%I(%s) from public,anon',r.proname,r.identity_args);
    execute format('grant execute on function private.%I(%s) to authenticated',r.proname,r.identity_args);
  end loop;
end
$block$;

commit;
