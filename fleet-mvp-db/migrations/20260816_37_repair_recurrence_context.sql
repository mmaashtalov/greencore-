create or replace function public.get_repair_recurrence_context(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  r public.repair_cases%rowtype;
  d public.vehicle_defects%rowtype;
  v_previous integer:=0;
  v_same integer:=0;
  v_needs_review boolean:=false;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into r from public.repair_cases where id=p_case_id;
  if r.id is null then raise exception 'Repair case not found'; end if;
  if r.defect_id is not null then select * into d from public.vehicle_defects where id=r.defect_id; end if;

  select count(*)::int into v_previous
    from public.repair_cases pr
   where pr.vehicle_id=r.vehicle_id and pr.id<>r.id and pr.status='closed' and pr.opened_at<r.opened_at;

  if d.category is not null then
    select count(*)::int into v_same
      from public.repair_cases pr
      join public.vehicle_defects pd on pd.id=pr.defect_id
     where pr.vehicle_id=r.vehicle_id and pr.id<>r.id and pr.status='closed' and pr.opened_at<r.opened_at
       and pd.category=d.category;
  end if;

  v_needs_review:=v_same>0 and (nullif(btrim(r.root_cause),'') is null or nullif(btrim(r.preventive_action),'') is null);

  return jsonb_build_object(
    'ui_version','repair_recurrence_v1',
    'case_id',r.id,
    'previous_repairs_count',v_previous,
    'same_category_prior_count',v_same,
    'repeat_signal',v_same>0,
    'needs_preventive_review',v_needs_review,
    'attention',case when v_same>0 then jsonb_build_object(
      'tone','warning',
      'label','Повторная неисправность',
      'detail',case when v_same=1 then 'На этой машине уже был один завершённый ремонт той же категории.' else format('На этой машине уже было %s завершённых ремонта той же категории.',v_same) end,
      'action_id',case when v_needs_review then 'edit_assessment' else 'none' end,
      'action_label',case when v_needs_review then 'Проверить причину и профилактику' else null end
    ) else null end,
    'previous_same_category',case when v_same=0 then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',x.id,'closed_at',x.closed_at,'diagnosis',x.diagnosis,'root_cause',x.root_cause,
        'preventive_action',x.preventive_action,'preventability',x.preventability
      ) order by x.closed_at desc)
      from (
        select pr.id,pr.closed_at,pr.diagnosis,pr.root_cause,pr.preventive_action,pr.preventability
          from public.repair_cases pr
          join public.vehicle_defects pd on pd.id=pr.defect_id
         where pr.vehicle_id=r.vehicle_id and pr.id<>r.id and pr.status='closed' and pr.opened_at<r.opened_at
           and pd.category=d.category
         order by pr.closed_at desc nulls last
         limit 3
      ) x
    ),'[]'::jsonb) end
  );
end
$function$;

revoke all on function public.get_repair_recurrence_context(uuid) from public,anon;
grant execute on function public.get_repair_recurrence_context(uuid) to authenticated;
