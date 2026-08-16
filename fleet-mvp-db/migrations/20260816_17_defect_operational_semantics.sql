create or replace function public.get_defect_card(p_defect_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog','public','private'
as $function$
declare d public.vehicle_defects%rowtype; v public.vehicles%rowtype; repair_id uuid; active_wb record; reporter text; severity_label text;
begin
  if auth.uid() is null or not private.is_admin() then raise exception 'Admin role required'; end if;
  select * into d from public.vehicle_defects where id=p_defect_id;
  if d.id is null then raise exception 'Неисправность не найдена'; end if;
  select * into v from public.vehicles where id=d.vehicle_id;
  select e.full_name into reporter from public.employees e where e.id=d.reported_by_driver_id;
  select r.id into repair_id from public.repair_cases r where r.defect_id=d.id and r.status not in ('closed','cancelled') order by r.opened_at desc limit 1;
  select w.id,w.number,w.status into active_wb from public.waybills w where w.vehicle_id=d.vehicle_id and w.status in ('issued','active') order by w.valid_from desc limit 1;
  severity_label := case when d.severity>=5 then 'Эксплуатацию прекратить' when d.severity>=3 then 'Нужна проверка' else 'Можно продолжать' end;
  return jsonb_build_object(
    'ui_version','defect_card_v2','id',d.id,'status',d.status,'reported_at',d.reported_at,'odometer_km',d.odometer_km,'category',d.category,'description',d.description,'severity',d.severity,'severity_label',severity_label,
    'vehicle',jsonb_build_object('id',v.id,'label',concat_ws(' ',v.make,v.model)||' №'||v.internal_number,'status',v.status),
    'reporter',reporter,
    'waybill',case when d.waybill_id is null then null else (select jsonb_build_object('id',w.id,'number',w.number,'status',w.status) from public.waybills w where w.id=d.waybill_id) end,
    'active_waybill',case when active_wb.id is null then null else jsonb_build_object('id',active_wb.id,'number',active_wb.number,'status',active_wb.status) end,
    'repair_case_id',repair_id,
    'next_step',case
      when repair_id is not null then jsonb_build_object('title','Ремонт уже открыт','detail','Продолжите работу в карточке ремонта.','action_id','open_repair')
      when active_wb.id is not null then jsonb_build_object('title','Сначала завершите путевой лист','detail','Диагностика начнётся после завершения действующего ПЛ '||active_wb.number||'.','action_id','open_waybill')
      when d.status in ('resolved','closed') then jsonb_build_object('title','Неисправность закрыта','detail','Дополнительных действий сейчас не требуется.','action_id','none')
      else jsonb_build_object('title',case when d.severity>=5 then 'Эксплуатацию прекратить' when d.severity>=3 then 'Проведите диагностику' else 'Проверьте неисправность' end,'detail','Следующий шаг — начать диагностику и зафиксировать результат.','action_id','start_diagnostics') end,
    'primary_action',case when repair_id is not null then jsonb_build_object('id','open_repair','label','Открыть ремонт','enabled',true,'target_id',repair_id)
      when active_wb.id is not null then jsonb_build_object('id','open_waybill','label','Сначала завершить ПЛ '||active_wb.number,'enabled',true,'target_id',active_wb.id)
      when d.status in ('resolved','closed') then jsonb_build_object('id','none','label','Закрыто','enabled',false)
      else jsonb_build_object('id','start_diagnostics','label','Начать диагностику','enabled',true) end,
    'ux_rules',jsonb_build_object('do_not_start_repair_during_active_waybill',true,'one_primary_action',true,'show_severity_as_operational_question',true)
  );
end $function$;