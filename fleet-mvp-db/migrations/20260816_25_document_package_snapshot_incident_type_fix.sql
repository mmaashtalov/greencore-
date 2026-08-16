create or replace function private.finalize_document_package_impl(p_package_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  d public.document_packages%rowtype;
  u jsonb;
  v_profile uuid;
  v_now timestamptz:=now();
  v_snapshot jsonb;
  v_vehicle jsonb;
  v_incident jsonb;
  v_repair jsonb;
  v_evidence jsonb;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into d from public.document_packages where id=p_package_id for update;
  if d.id is null then raise exception 'Document package not found'; end if;
  if d.status='issued' then return private.get_document_package_ui_impl(p_package_id); end if;
  if d.status='archived' then raise exception 'Package is archived'; end if;
  if d.status<>'ready' then raise exception 'Package must be prepared before finalization'; end if;

  u:=private.get_document_package_ui_impl(p_package_id);
  if coalesce((u->>'data_ready')::boolean,false)=false then raise exception 'Package data is incomplete'; end if;
  select id into v_profile from public.profiles where id=auth.uid();

  select jsonb_build_object(
    'id',v.id,'make',v.make,'model',v.model,'internal_number',v.internal_number,
    'registration_number',v.registration_number,'asset_type',v.asset_type,'status_at_formation',v.status
  ) into v_vehicle from public.vehicles v where v.id=d.vehicle_id;

  if d.incident_id is not null then
    select jsonb_build_object(
      'id',i.id,'occurred_at',i.occurred_at,'category',i.incident_type,'location',i.location_name,
      'description',i.description,'outcome',i.outcome,'status_at_formation',i.status,
      'last_confirmed_odometer_km',i.last_confirmed_odometer_km,'last_confirmed_fuel_l',i.last_confirmed_fuel_l,
      'waybill_id',i.waybill_id
    ) into v_incident from public.vehicle_incidents i where i.id=d.incident_id;
  end if;

  if d.repair_case_id is not null then
    select jsonb_build_object(
      'id',r.id,'status_at_formation',r.status,'opened_at',r.opened_at,'closed_at',r.closed_at,
      'diagnosis',r.diagnosis,'root_cause',r.root_cause,'preventability',r.preventability,
      'preventive_action',r.preventive_action
    ) into v_repair from public.repair_cases r where r.id=d.repair_case_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',e.id,'type',e.evidence_type,'description',e.description,'storage_path',e.storage_path,
    'sha256',e.sha256,'created_at',e.created_at
  ) order by e.created_at),'[]'::jsonb) into v_evidence
  from public.incident_evidence e where e.incident_id=d.incident_id;

  v_snapshot:=jsonb_build_object(
    'schema_version','package_snapshot_v1',
    'package_id',d.id,'package_type',d.package_type,'formed_at',v_now,'formed_by_profile_id',v_profile,
    'prepared_at',d.prepared_at,'vehicle',v_vehicle,'incident',v_incident,'repair',v_repair,
    'evidence',coalesce(v_evidence,'[]'::jsonb),'checklist',coalesce(u->'checklist','[]'::jsonb)
  );

  update public.document_packages
     set status='issued',generated_at=coalesce(generated_at,v_now),generated_by=coalesce(generated_by,v_profile),updated_at=v_now,
         metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
           'mvp_formed_at',v_now,
           'package_snapshot',v_snapshot,
           'snapshot_schema_version','package_snapshot_v1'
         )
   where id=p_package_id;
  return private.get_document_package_ui_impl(p_package_id);
end
$function$;