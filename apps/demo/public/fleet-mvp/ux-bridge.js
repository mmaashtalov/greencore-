const UX_BRIDGE_VERSION='2026.08.15-2';

function humanErrorText(text=''){
  const value=String(text||'').trim();
  const rules=[
    [/permission denied for function/i,'Недостаточно прав для этого действия. Обновите страницу; если ошибка повторится — обратитесь к администратору.'],
    [/Admin role required/i,'Действие доступно только администратору.'],
    [/Driver role required/i,'Действие доступно только водителю.'],
    [/Waybill does not belong to current driver|Waybill is not current for driver/i,'Этот путевой лист не относится к текущему водителю. Обновите экран.'],
    [/Driver license expires before waybill end date/i,'Удостоверение водителя не действует до конца выбранного срока ПЛ.'],
    [/Driver not found, inactive, or license validity is not configured/i,'Водитель не найден, отключён или не указан срок действия удостоверения.'],
    [/Driver lacks required license category|Категория водительского удостоверения не подходит/i,'Выберите водителя с необходимой категорией допуска.'],
    [/Driver already has active waybill/i,'У выбранного водителя уже есть действующий путевой лист.'],
    [/Vehicle already has active waybill/i,'На выбранную машину уже выдан действующий путевой лист.'],
    [/Trailer already has active waybill/i,'Выбранный прицеп уже используется по другому действующему путевому листу.'],
    [/Vehicle is not available for operation/i,'Эта техника сейчас недоступна для эксплуатации.'],
    [/Trailer is not available for operation/i,'Этот прицеп сейчас недоступен для эксплуатации.'],
    [/Cannot close waybill while vehicle is moving/i,'Сначала отметьте прибытие. ПЛ нельзя закрыть во время движения.'],
    [/Closing fuel exceeds tank capacity/i,'Остаток топлива не может быть больше объёма бака. Проверьте показание.'],
    [/Closing fuel exceeds opening fuel plus registered refuels/i,'Остаток топлива больше доступного по учёту. Проверьте заправки и остаток.'],
    [/Closing odometer is below last recorded odometer|Odometer cannot decrease/i,'Показание одометра не может быть меньше ранее зафиксированного.'],
    [/Event is older than already recorded vehicle state|Closing timestamp is older than already recorded vehicle state/i,'В системе уже есть более позднее состояние машины. Обновите экран и повторите действие.'],
    [/Invalid driver event transition/i,'Последовательность действий изменилась. Обновите экран — система покажет доступное действие.'],
    [/Refuel quantity exceeds tank capacity/i,'Объём одной заправки не может быть больше объёма бака. Проверьте литры.'],
    [/Route coverage check failed/i,'Маршрут не покрывает весь пробег ПЛ. Перед утверждением разберите маршрутные данные.'],
    [/Refuel reconciliation check failed/i,'Сумма заправок не сходится с учётом ПЛ. Перед утверждением разберите заправки.'],
    [/Action is not available now/i,'Это действие сейчас недоступно. Обновите экран.'],
    [/Package data is incomplete/i,'Для формирования пакета не хватает обязательных данных.'],
    [/Waybills still require review|Reporting period has waybills requiring review/i,'Сначала завершите проверку путевых листов.'],
    [/Reporting period boundary data is incomplete|Reporting period has unresolved boundary\/segment issues/i,'Не подтверждено состояние техники на границе отчётного периода.'],
    [/Reporting period has legacy waybill quality issues/i,'В периоде есть ранее утверждённые ПЛ с историческими несоответствиями. Сначала разберите их.'],
    [/Reporting statement has no printable blocks/i,'Для этого периода не сформированы блоки ведомости.'],
    [/Reporting period is not under review/i,'Сначала начните сверку отчётного периода.'],
    [/Reporting period has not ended/i,'Отчётный период ещё не завершён.'],
    [/Current fuel norm is not configured/i,'Для машины не задана действующая норма расхода топлива.'],
    [/Authentication required/i,'Сессия завершена. Войдите в систему снова.'],
    [/Profile not found|Employee profile not found/i,'Для этой учётной записи не настроен профиль пользователя.']
  ];
  const match=rules.find(([re])=>re.test(value));
  return match?match[1]:value;
}

function translateVisibleErrors(root=document){
  root.querySelectorAll?.('.toast,.alert-sub').forEach(el=>{
    const current=(el.textContent||'').trim();
    if(!current||el.dataset.humanized===UX_BRIDGE_VERSION)return;
    const next=humanErrorText(current);
    if(next!==current)el.textContent=next;
    el.dataset.humanized=UX_BRIDGE_VERSION;
  });
}

let pending=false;
function scan(){pending=false;translateVisibleErrors();}
function schedule(){if(pending)return;pending=true;queueMicrotask(scan);}
new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
schedule();
