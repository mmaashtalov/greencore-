const UX_BRIDGE_VERSION='2026.08.15-1';

function humanErrorText(text=''){
  const value=String(text||'').trim();
  const rules=[
    [/permission denied for function/i,'Недостаточно прав для этого действия. Обновите страницу; если ошибка повторится — обратитесь к администратору.'],
    [/Admin role required/i,'Действие доступно только администратору.'],
    [/Driver role required/i,'Действие доступно только водителю.'],
    [/Driver lacks required license category|Категория водительского удостоверения не подходит/i,'Выберите водителя с необходимой категорией допуска.'],
    [/Driver already has active waybill/i,'У выбранного водителя уже есть действующий путевой лист.'],
    [/Vehicle already has active waybill/i,'На выбранную машину уже выдан действующий путевой лист.'],
    [/Trailer already has active waybill/i,'Выбранный прицеп уже используется по другому действующему путевому листу.'],
    [/Vehicle is not available for operation/i,'Эта техника сейчас недоступна для эксплуатации.'],
    [/Trailer is not available for operation/i,'Этот прицеп сейчас недоступен для эксплуатации.'],
    [/Action is not available now/i,'Это действие сейчас недоступно. Обновите экран.'],
    [/Package data is incomplete/i,'Для формирования пакета не хватает обязательных данных.'],
    [/Waybills still require review/i,'Сначала завершите проверку путевых листов.'],
    [/Reporting period boundary data is incomplete/i,'Не подтверждено состояние техники на границе отчётного периода.'],
    [/Reporting period has not ended/i,'Отчётный период ещё не завершён.'],
    [/Current fuel norm is not configured/i,'Для машины не задана действующая норма расхода топлива.'],
    [/Authentication required/i,'Сессия завершена. Войдите в систему снова.'],
    [/Profile not found/i,'Для этой учётной записи не настроен профиль пользователя.']
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

async function openPeriodAttention(periodId){
  const printNav=document.querySelector('.nav-btn[data-id="print"]');
  if(!printNav)return;
  printNav.click();
  for(let i=0;i<40;i++){
    await new Promise(r=>setTimeout(r,100));
    const card=document.querySelector(`[data-action="print-statement"][data-id="${CSS.escape(periodId)}"]`);
    if(card){card.click();return;}
  }
  const host=document.querySelector('.toast-host')||document.body;
  const el=document.createElement('div');
  el.className='toast error';
  el.textContent='Не удалось открыть сверку периода. Обновите страницу.';
  host.appendChild(el);
  setTimeout(()=>el.remove(),3600);
}

document.addEventListener('click',e=>{
  const card=e.target.closest('[data-action="attention"][data-id^="reporting_period:"]');
  if(!card)return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const periodId=(card.dataset.id||'').split(':')[1];
  if(periodId)openPeriodAttention(periodId);
},true);

let pending=false;
function scan(){pending=false;translateVisibleErrors();}
function schedule(){if(pending)return;pending=true;queueMicrotask(scan);}
new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
schedule();
