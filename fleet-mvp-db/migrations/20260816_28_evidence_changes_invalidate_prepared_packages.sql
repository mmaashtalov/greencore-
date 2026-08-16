create or replace function private.invalidate_incident_ready_packages(p_incident_id uuid,p_reason text)
returns void
language sql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
  update public.document_packages
     set status='draft',prepared_at=null,prepared_by=null,updated_at=now(),
         metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('prepared_reset_reason',p_reason,'prepared_reset_at',now())
   where incident_id=p_incident_id and status='ready';
$function$;

create or replace function private.void_incident_evidence_impl(p_evidence_id uuid,p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  e public.incident_evidence%rowtype;
  v_profile uuid;
  v_reason text:=nullif(btrim(p_reason),'');
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  if v_reason is null then raise exception 'Exclusion reason is required'; end if;
  if length(v_reason)>500 then raise exception 'Exclusion reason is too long'; end if;
  select * into e from public.incident_evidence where id=p_evidence_id for update;
  if e.id is null then raise exception 'Evidence not found'; end if;
  if exists(select 1 from public.document_packages d where d.incident_id=e.incident_id and d.status in ('issued','archived')) then
    raise exception 'Evidence cannot be excluded after package formation';
  end if;
  select id into v_profile from public.profiles where id=auth.uid();
  insert into private.incident_evidence_voids(
    original_evidence_id,incident_id,evidence_type,storage_path,sha256,description,
    original_created_at,original_uploaded_by,voided_by,reason
  ) values(
    e.id,e.incident_id,e.evidence_type,e.storage_path,e.sha256,e.description,
    e.created_at,e.uploaded_by,v_profile,v_reason
  );
  delete from public.incident_evidence where id=e.id;
  perform private.invalidate_incident_ready_packages(e.incident_id,'evidence_excluded');
  return private.get_incident_evidence_ui_impl(e.incident_id);
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

revoke all on function private.invalidate_incident_ready_packages(uuid,text) from public,anon,authenticated;