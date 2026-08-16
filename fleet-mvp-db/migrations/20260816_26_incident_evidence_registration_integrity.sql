create unique index if not exists incident_evidence_storage_path_uidx
  on public.incident_evidence(storage_path);

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
  if not exists(select 1 from storage.objects where bucket_id='incident-evidence' and name=v_path) then raise exception 'Uploaded file not found'; end if;

  select e.id into v_id from public.incident_evidence e where e.storage_path=v_path;
  if v_id is not null then
    if not exists(select 1 from public.incident_evidence e where e.id=v_id and e.incident_id=p_incident_id) then
      raise exception 'Evidence path is already registered for another incident';
    end if;
    return v_id;
  end if;

  select id into v_profile from public.profiles where id=auth.uid();
  insert into public.incident_evidence(incident_id,evidence_type,storage_path,description,sha256,uploaded_by)
  values(p_incident_id,v_type,v_path,nullif(btrim(p_description),''),v_sha,v_profile)
  returning id into v_id;
  return v_id;
end
$function$;