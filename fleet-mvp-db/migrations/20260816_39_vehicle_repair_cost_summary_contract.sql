create or replace function public.get_vehicle_repair_cost_summary(p_vehicle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare
  v public.vehicles%rowtype;
  v_total_repairs integer:=0;
  v_closed_repairs integer:=0;
  v_open_repairs integer:=0;
  v_work_items integer:=0;
  v_priced_work_items integer:=0;
  v_repairs_with_work integer:=0;
  v_closed_without_work integer:=0;
  v_recorded_cost numeric:=0;
  v_first_cost_at timestamptz;
  v_completeness text;
  v_label text;
  v_note text;
begin
  if auth.uid() is null or not private.is_admin() then
    raise exception 'Admin role required';
  end if;

  select * into v from public.vehicles where id=p_vehicle_id;
  if v.id is null then raise exception 'Vehicle not found'; end if;

  select
    count(*)::integer,
    count(*) filter (where r.status='closed')::integer,
    count(*) filter (where r.status not in ('closed','cancelled'))::integer
  into v_total_repairs,v_closed_repairs,v_open_repairs
  from public.repair_cases r
  where r.vehicle_id=v.id;

  select
    count(w.id)::integer,
    count(w.id) filter (where w.cost_amount is not null)::integer,
    count(distinct r.id)::integer,
    coalesce(sum(w.cost_amount) filter (where w.cost_amount is not null),0),
    min(w.completed_at) filter (where w.cost_amount is not null)
  into v_work_items,v_priced_work_items,v_repairs_with_work,v_recorded_cost,v_first_cost_at
  from public.repair_cases r
  join public.repair_work_items w on w.repair_case_id=r.id and w.completed_at is not null
  where r.vehicle_id=v.id;

  select count(*)::integer into v_closed_without_work
  from public.repair_cases r
  where r.vehicle_id=v.id and r.status='closed'
    and not exists (
      select 1 from public.repair_work_items w
      where w.repair_case_id=r.id and w.completed_at is not null
    );

  if v_total_repairs=0 then
    v_completeness:='no_history';
    v_label:='Ремонтов пока нет';
    v_note:='История затрат начнёт формироваться после первого ремонта.';
  elsif v_work_items=0 then
    v_completeness:='no_cost_data';
    v_label:='Стоимость пока не зафиксирована';
    v_note:='По ремонтам ещё нет сохранённых выполненных работ. Нельзя считать нулевые затраты подтверждёнными.';
  elsif v_closed_without_work>0 or v_priced_work_items<v_work_items then
    v_completeness:='partial';
    v_label:='История затрат неполная';
    v_note:='Сумма включает только работы, для которых стоимость была явно записана. Пустая стоимость не считается нулём.';
  elsif v_closed_repairs=0 then
    v_completeness:='accumulating';
    v_label:='Затраты записываются';
    v_note:='Есть данные по текущим ремонтам, но завершённой истории ремонтов пока нет.';
  else
    v_completeness:='recorded_complete';
    v_label:='Записанные затраты полные';
    v_note:='Для всех сохранённых выполненных работ указана стоимость, а закрытые ремонты имеют журнал работ.';
  end if;

  return jsonb_build_object(
    'ui_version','vehicle_repair_cost_v1',
    'vehicle',jsonb_build_object(
      'id',v.id,
      'label',concat_ws(' ',v.make,v.model,'№'||coalesce(v.internal_number,''))
    ),
    'summary',jsonb_build_object(
      'repair_count',v_total_repairs,
      'closed_repair_count',v_closed_repairs,
      'open_repair_count',v_open_repairs,
      'repairs_with_work_items',v_repairs_with_work,
      'completed_work_items',v_work_items,
      'priced_work_items',v_priced_work_items,
      'unpriced_work_items',greatest(v_work_items-v_priced_work_items,0),
      'closed_repairs_without_work_log',v_closed_without_work,
      'recorded_total_cost',v_recorded_cost,
      'recorded_cost_available',(v_priced_work_items>0),
      'first_recorded_cost_at',v_first_cost_at
    ),
    'completeness',jsonb_build_object(
      'status',v_completeness,
      'label',v_label,
      'note',v_note
    ),
    'repairs',coalesce((
      select jsonb_agg(jsonb_build_object(
        'repair_id',q.repair_id,
        'status',q.status,
        'opened_at',q.opened_at,
        'closed_at',q.closed_at,
        'category',q.category,
        'diagnosis',q.diagnosis,
        'completed_work_items',q.work_items,
        'priced_work_items',q.priced_items,
        'recorded_cost',q.recorded_cost,
        'cost_complete',(q.priced_items=q.work_items and q.work_items>0)
      ) order by q.recorded_cost desc,q.opened_at desc)
      from (
        select r.id repair_id,r.status::text status,r.opened_at,r.closed_at,
               nullif(btrim(d.category),'') category,r.diagnosis,
               count(w.id)::integer work_items,
               count(w.id) filter (where w.cost_amount is not null)::integer priced_items,
               coalesce(sum(w.cost_amount) filter (where w.cost_amount is not null),0) recorded_cost
        from public.repair_cases r
        left join public.vehicle_defects d on d.id=r.defect_id
        join public.repair_work_items w on w.repair_case_id=r.id and w.completed_at is not null
        where r.vehicle_id=v.id
        group by r.id,r.status,r.opened_at,r.closed_at,d.category,r.diagnosis
        order by recorded_cost desc,r.opened_at desc
        limit 5
      ) q
    ),'[]'::jsonb),
    'ux_rules',jsonb_build_object(
      'show_recorded_not_actual_cost',true,
      'null_cost_means_unknown',true,
      'explicit_zero_cost_is_valid',true,
      'max_repair_rows',5
    )
  );
end;
$function$;

revoke all on function public.get_vehicle_repair_cost_summary(uuid) from public;
revoke all on function public.get_vehicle_repair_cost_summary(uuid) from anon;
grant execute on function public.get_vehicle_repair_cost_summary(uuid) to authenticated;
