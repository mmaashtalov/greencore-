create or replace function private.get_incident_evidence_ui_impl(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  v_can_mutate boolean;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  if not exists(select 1 from public.vehicle_incidents where id=p_incident_id) then raise exception 'Incident not found'; end if;
  v_can_mutate := not exists(
    select 1 from public.document_packages d
     where d.incident_id=p_incident_id and d.status in ('issued','archived')
  );
  return jsonb_build_object(
    'ui_version','incident_evidence_v2',
    'incident_id',p_incident_id,
    'can_add',v_can_mutate,
    'can_void',v_can_mutate,
    'active',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',e.id,'type',e.evidence_type,'description',e.description,
        'storage_path',e.storage_path,'sha256',e.sha256,'created_at',e.created_at,
        'can_void',v_can_mutate
      ) order by e.created_at desc)
      from public.incident_evidence e where e.incident_id=p_incident_id
    ),'[]'::jsonb),
    'excluded',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',x.original_evidence_id,'type',x.evidence_type,'description',x.description,
        'storage_path',x.storage_path,'sha256',x.sha256,'created_at',x.original_created_at,
        'voided_at',x.voided_at,'reason',x.reason
      ) order by x.voided_at desc)
      from (select * from private.incident_evidence_voids where incident_id=p_incident_id order by voided_at desc limit 20) x
    ),'[]'::jsonb),
    'ux_rules',jsonb_build_object(
      'active_only_counts_for_packages',true,
      'storage_object_preserved_on_void',true,
      'evidence_set_frozen_after_package_formation',true
    )
  );
end
$function$;

create or replace function private.register_incident_evidence_impl(
  p_incident_id uuid,
  p_evidence_type text,
  p_storage_path text,
  p_description text default null,
  p_sha256 text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog','public','private','storage'
as $function$
declare
  v_id uuid;
  v_profile uuid;
  v_type text:=lower(nullif(btrim(p_evidence_type),''));
  v_path text:=nullif(btrim(p_storage_path),'');
  v_sha text:=lower(nullif(btrim(p_sha256),''));
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  if not exists(select 1 from public.vehicle_incidents where id=p_incident_id) then raise exception 'Incident not found'; end if;
  if exists(select 1 from public.document_packages d where d.incident_id=p_incident_id and d.status in ('issued','archived')) then
    raise exception 'Evidence cannot be added after package formation';
  end if;
  if v_type is null or v_type not in ('photo','pdf') then raise exception 'Unsupported evidence type'; end if;
  if v_path is null then raise exception 'Storage path required'; end if;
  if split_part(v_path,'/',1) <> p_incident_id::text then raise exception 'Evidence must be stored inside incident folder'; end if;
  if v_sha is not null and v_sha !~ '^[0-9a-f]{64}$' then raise exception 'Invalid SHA-256'; end if;
  if exists(select 1 from private.incident_evidence_voids x where x.storage_path=v_path) then raise exception 'Excluded evidence path cannot be registered again'; end if;
  if not exists(select 1 from storage.objects where bucket_id='incident-evidence' and name=v_path) then raise exception 'Uploaded file not found'; end if;
  select e.id into v_id from public.incident_evidence e where e.storage_path=v_path;
  if v_id is not null then
    if not exists(select 1 from public.incident_evidence e where e.id=v_id and e.incident_id=p_incident_id) then raise exception 'Evidence path is already registered for another incident'; end if;
    return v_id;
  end if;
  select id into v_profile from public.profiles where id=auth.uid();
  insert into public.incident_evidence(incident_id,evidence_type,storage_path,description,sha256,uploaded_by)
  values(p_incident_id,v_type,v_path,nullif(btrim(p_description),''),v_sha,v_profile)
  returning id into v_id;
  perform private.invalidate_incident_ready_packages(p_incident_id,'evidence_added');
  return v_id;
end
$function$;