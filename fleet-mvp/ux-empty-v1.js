const UXE_VERSION='2026.08.15-empty1';
function uxeText(el){return (el?.textContent||'').replace(/\s+/g,' ').trim()}
function uxeSpec(main,empty){
  const title=uxeText(main.querySelector('.page-title'));
  const text=uxeText(empty).toLowerCase();
  const section=uxeText(empty.closest('section')?.querySelector('.section-title')).toLowerCase();
  if(title==='Проверка путевых листов')return {icon:'✓',title:'Очередь разобрана',body:'Сейчас нет путевых листов, ожидающих проверки.',action:'issue-waybill',label:'Выдать новый ПЛ',kind:'primary'};
  if(title==='ТО и ремонт')return {icon:'✓',title:'Новых задач нет',body:'По ТО, ремонтам и неисправностям сейчас ничего не требует решения.',action:'main-nav',dataId:'fleet',label:'Открыть технику',kind:'soft'};
  if(title==='Техника'&&/не добавлена|нет данных/.test(text))return {icon:'＋',title:'Техника ещё не добавлена',body:'Добавьте первую единицу техники — после этого появятся карточки, ПЛ и обслуживание.',action:'add-vehicle',label:'Добавить технику',kind:'primary'};
  if(title==='Водители'&&/не добавлен|нет данных/.test(text))return {icon:'＋',title:'Водители ещё не добавлены',body:'Добавьте водителя и укажите категории допуска.',action:'add-driver',label:'Добавить водителя',kind:'primary'};
  if(title==='Происшествия'&&/нереш|нет данных/.test(text))return {icon:'✓',title:'Нерешённых происшествий нет',body:'Все зафиксированные события разобраны или не требуют решения.'};
  if(title==='Печать'&&section.includes('путевые листы'))return {icon:'▤',title:'Нет путевых листов для печати',body:'Сначала выдайте путевой лист.',action:'issue-waybill',label:'Выдать ПЛ',kind:'primary'};
  if(title==='Печать'&&section.includes('сводные ведомости'))return {icon:'▤',title:'Ведомостей пока нет',body:'Сводные ведомости появятся после формирования отчётного периода.'};
  if(title==='История')return {icon:'↺',title:'История пока пуста',body:'Здесь появятся завершённые путевые листы.'};
  if(/нет задач по то и ремонту/.test(text))return {icon:'✓',title:'Новых задач нет',body:'Обслуживание не требует внимания.'};
  if(/сейчас нет задач, требующих решения/.test(text))return {icon:'✓',title:'Всё спокойно',body:'Критичных задач сейчас нет.'};
  if(text==='нет данных'||text==='нет данных.')return {icon:'—',title:'Пока нет данных',body:'Данные появятся после первых операций в этом разделе.'};
  return null;
}
function uxeButton(s){if(!s.action)return'';const cls=s.kind==='primary'?'primary-btn':'soft-btn';const data=s.dataId?` data-id="${s.dataId}"`:'';return `<button type="button" class="${cls}" data-action="${s.action}"${data}>${s.label}</button>`}
function uxeDecorate(){const main=document.querySelector('.main');if(!main)return;main.querySelectorAll('.empty:not(.ux-search-empty)').forEach(empty=>{if(empty.dataset.uxe===UXE_VERSION)return;const s=uxeSpec(main,empty);if(!s)return;empty.dataset.uxe=UXE_VERSION;empty.classList.add('uxe-state');empty.innerHTML=`<div class="uxe-icon" aria-hidden="true">${s.icon}</div><div class="uxe-copy"><strong>${s.title}</strong><p>${s.body}</p></div>${s.action?`<div class="uxe-actions">${uxeButton(s)}</div>`:''}`});main.querySelectorAll('.alert.danger').forEach(alert=>{if(alert.dataset.uxeRetry===UXE_VERSION)return;const t=uxeText(alert.querySelector('.alert-title'));if(t!=='Не удалось загрузить экран')return;alert.dataset.uxeRetry=UXE_VERSION;const body=alert.querySelector('.alert-sub')?.parentElement;if(!body)return;const row=document.createElement('div');row.className='uxe-retry';row.innerHTML='<button type="button" class="soft-btn" data-action="refresh">Повторить загрузку</button>';body.appendChild(row)})}
let uxePending=false;function uxeSchedule(){if(uxePending)return;uxePending=true;queueMicrotask(()=>{uxePending=false;uxeDecorate()})}new MutationObserver(uxeSchedule).observe(document.documentElement,{childList:true,subtree:true});uxeSchedule();