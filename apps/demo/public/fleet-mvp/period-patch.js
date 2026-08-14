const PERIOD_CFG = {
  url: 'https://tikjmiyrhkcjrxjylmqb.supabase.co',
  key: 'sb_publishable_clr5P9USk7b63MajJmmr9A_Iz0wi_0F',
  version: '2026.08.15-period1'
};
const PERIOD_SESSION_KEY = 'fleet_mvp_session_v2';
let activePeriodReview = null;
let decoratingPrintCenter = false;

function periodSession() {
  try { return JSON.parse(localStorage.getItem(PERIOD_SESSION_KEY) || 'null'); } catch { return null; }
}
function periodSaveSession(session) {
  if (session) localStorage.setItem(PERIOD_SESSION_KEY, JSON.stringify(session));
}
async function periodRefreshSession() {
  const session = periodSession();
  if (!session?.refresh_token) throw new Error('Сессия истекла. Войдите снова.');
  const res = await fetch(`${PERIOD_CFG.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {apikey: PERIOD_CFG.key, 'Content-Type':'application/json'},
    body: JSON.stringify({refresh_token: session.refresh_token})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.message || data.msg || 'Сессия истекла. Войдите снова.');
  data.obtained_at = Date.now();
  periodSaveSession(data);
  return data;
}
async function periodRpc(name, params={}, retry=true) {
  let session = periodSession();
  if (!session?.access_token) throw new Error('Нужно войти в систему.');
  let res = await fetch(`${PERIOD_CFG.url}/rest/v1/rpc/${encodeURIComponent(name)}`, {
    method:'POST',
    headers:{apikey:PERIOD_CFG.key,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},
    body:JSON.stringify(params)
  });
  if (res.status===401 && retry) {
    session = await periodRefreshSession();
    res = await fetch(`${PERIOD_CFG.url}/rest/v1/rpc/${encodeURIComponent(name)}`, {
      method:'POST',
      headers:{apikey:PERIOD_CFG.key,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},
      body:JSON.stringify(params)
    });
  }
  if (!res.ok) {
    const x=await res.json().catch(()=>({}));
    throw new Error(x.message||x.error||`HTTP ${res.status}`);
  }
  const text=await res.text();
  return text?JSON.parse(text):null;
}
function ph(value='') {
  return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function pnum(value,digits=0) {
  if (value===null||value===undefined||value==='') return '—';
  const n=Number(value);
  return Number.isFinite(n)?n.toLocaleString('ru-RU',{maximumFractionDigits:digits}):ph(value);
}
function pdt(value) {
  if (!value) return '—';
  const d=new Date(value);
  if (Number.isNaN(d.getTime())) return ph(value);
  return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
}
function friendlyPeriodError(message='') {
  const m=String(message||'');
  const pairs=[
    ['Reporting period has not ended','Период ещё не завершён.'],
    ['Waybills still require review','Сначала завершите проверку путевых листов.'],
    ['Reporting period boundary data is incomplete','Не подтверждено состояние техники на границе периода.'],
    ['Reporting period is not under review','Сначала начните сверку периода.'],
    ['Reporting period is closed','Период уже закрыт.'],
    ['Boundary odometer is lower than last known odometer','Пробег на границе меньше последнего подтверждённого значения.'],
    ['Boundary odometer is higher than next known odometer','Пробег на границе больше следующего подтверждённого значения.'],
    ['Fuel amount exceeds tank capacity','Остаток топлива больше ёмкости бака.'],
    ['Invalid odometer','Проверьте значение одометра.'],
    ['Invalid fuel amount','Проверьте остаток топлива.'],
    ['Admin role required','Действие доступно только администратору.']
  ];
  const hit=pairs.find(([a])=>m.includes(a));
  return hit?hit[1]:m;
}
function periodToast(text,type='') {
  let host=document.querySelector('.toast-host');
  if (!host) {
    host=document.createElement('div');
    host.className='toast-host';
    document.body.appendChild(host);
  }
  const el=document.createElement('div');
  el.className=`toast ${type}`;
  el.textContent=text;
  host.appendChild(el);
  setTimeout(()=>el.remove(),3600);
}
function periodBadge(label,tone='') {
  return `<span class="badge ${tone}">${ph(label||'')}</span>`;
}
function findStatementItem(printCenter,periodId) {
  const section=(printCenter?.sections||[]).find(s=>s.id==='statements');
  return (section?.items||[]).find(i=>i.id===periodId)||null;
}
async function decoratePrintCenter() {
  if (decoratingPrintCenter) return;
  const title=document.querySelector('.page-title')?.textContent?.trim();
  if (title!=='Печать') return;
  const cards=[...document.querySelectorAll('[data-action="print-statement"]')];
  if (!cards.length || cards.every(c=>c.dataset.periodMode)) return;
  decoratingPrintCenter=true;
  try {
    const pc=await periodRpc('get_print_center');
    for (const card of cards) {
      const item=findStatementItem(pc,card.dataset.id);
      const mode=item?.primary_action?.id||'print_statement';
      card.dataset.periodMode=mode;
      card.dataset.periodEnabled=String(item?.primary_action?.enabled!==false);
      if (mode==='none') card.classList.add('patch-disabled');
    }
  } catch (e) {
    console.warn('Period decoration failed',e);
  } finally {
    decoratingPrintCenter=false;
  }
}
function reviewTone(x) {
  if (x?.period?.status==='closed') return 'success';
  if ((x?.summary?.blocking_issues||0)>0) return 'warning';
  return 'info';
}
function renderPeriodReviewData(x) {
  activePeriodReview=x;
  const main=document.querySelector('.main');
  if (!main) return;
  const s=x.summary||{};
  const boundaries=(x.boundary_requests||[]).map(t=>{
    const enabled=x.period?.status==='under_review' && t.primary_action?.enabled;
    const last=t.last_known;
    return `<div class="list-item period-task">
      <div class="list-main"><div class="list-title">${ph(t.vehicle)}</div>
      <div class="list-sub">${ph(t.label)} · ${pdt(t.boundary_at)}${last?`<br>Последнее известное: ${pnum(last.odometer_km)} км · ${pdt(last.occurred_at)}`:''}</div></div>
      <button class="${enabled?'primary-btn':'ghost-btn'} period-inline-btn" data-period-action="boundary" data-task="${ph(t.id)}" ${enabled?'':'disabled'}>${enabled?'Ввести':'Сначала сверка'}</button>
    </div>`;
  }).join('');
  const waybills=(x.waybill_tasks||[]).map(t=>`<div class="list-item clickable" data-action="open-waybill-review" data-id="${ph(t.id)}">
    <div class="list-main"><div class="list-title">ПЛ ${ph(t.number)} · ${ph(t.vehicle)}</div><div class="list-sub">${ph(t.status_label)}</div></div><div class="chev">›</div></div>`).join('');
  const other=(x.other_segment_issues||[]).map(t=>`<div class="alert warning"><div>△</div><div><div class="alert-title">ПЛ ${ph(t.waybill_number)}</div><div class="alert-sub">${ph(t.vehicle)} · ${ph(t.label)}</div></div></div>`).join('');
  const pa=x.primary_action||{};
  let primary='';
  if (pa.id==='begin_review' && pa.enabled) primary=`<button class="primary-btn btn-block" data-period-action="begin" data-period="${ph(x.period.id)}">${ph(pa.label)}</button>`;
  else if (pa.id==='close_period' && pa.enabled) primary=`<button class="primary-btn btn-block" data-period-action="close" data-period="${ph(x.period.id)}">${ph(pa.label)}</button>`;
  else if (pa.id==='open_statement' && pa.enabled) primary=`<button class="primary-btn btn-block" data-action="print-statement" data-period-mode="print_statement" data-id="${ph(x.period.id)}">${ph(pa.label)}</button>`;
  else primary=`<button class="ghost-btn btn-block" disabled>${ph(pa.label||'Нет доступных действий')}</button>`;

  main.innerHTML=`
    <div class="page-head"><button class="back-btn" data-period-action="back">‹</button><div class="page-title-wrap"><h1 class="page-title">${ph(x.title||'Проверка периода')}</h1><p class="page-subtitle">${ph(x.period?.label||'')} · ${ph(x.period?.status_label||'')}</p></div></div>
    <div class="card period-summary-card"><div class="card-head"><div><div class="card-title">Состояние периода</div><div class="card-sub">${ph(x.subtitle||'')}</div></div>${periodBadge(x.period?.status_label,reviewTone(x))}</div>
      <div class="grid grid-3 period-metrics" style="margin-top:14px">
        <div class="metric"><div class="metric-value">${pnum(s.boundary_tasks,0)}</div><div class="metric-label">Граница периода</div></div>
        <div class="metric"><div class="metric-value">${pnum(s.waybill_tasks,0)}</div><div class="metric-label">ПЛ требуют решения</div></div>
        <div class="metric"><div class="metric-value">${pnum(s.statement_blocks,0)}</div><div class="metric-label">Блоков ведомости</div></div>
      </div>
    </div>
    ${boundaries?`<section class="section"><h2 class="section-title">Нужно подтвердить на границе</h2><div class="list">${boundaries}</div></section>`:''}
    ${waybills?`<section class="section"><h2 class="section-title">Путевые листы требуют решения</h2><div class="list">${waybills}</div></section>`:''}
    ${other?`<section class="section"><h2 class="section-title">Не хватает данных</h2>${other}</section>`:''}
    ${!boundaries&&!waybills&&!other&&x.period?.status!=='closed'?`<section class="section"><div class="alert success"><div>✓</div><div><div class="alert-title">Сверка чистая</div><div class="alert-sub">Все данные периода согласованы.</div></div></div></section>`:''}
    <div class="action-row period-primary">${primary}</div>`;
  window.scrollTo({top:0,behavior:'smooth'});
}
async function openPeriodReview(periodId) {
  const main=document.querySelector('.main');
  if (main) main.innerHTML='<div class="inline-loading"><div class="spinner"></div><div>Проверяем период…</div></div>';
  try {
    const x=await periodRpc('get_reporting_period_review_ui',{p_period_id:periodId});
    renderPeriodReviewData(x);
  } catch (e) {
    periodToast(friendlyPeriodError(e.message),'error');
    document.querySelector('.nav-btn[data-id="print"]')?.click();
  }
}
function closeBoundaryDialog() {
  document.querySelector('.period-modal-backdrop')?.remove();
}
function openBoundaryDialog(task) {
  closeBoundaryDialog();
  const overlay=document.createElement('div');
  overlay.className='period-modal-backdrop';
  const last=task.last_known;
  overlay.innerHTML=`<div class="period-modal" role="dialog" aria-modal="true">
    <div class="period-modal-head"><div><div class="card-title">Состояние на границе</div><div class="card-sub">${ph(task.vehicle)} · ${pdt(task.boundary_at)}</div></div><button class="icon-close" type="button" data-period-action="cancel-boundary">×</button></div>
    ${last?`<div class="demo-note">Последнее известное до границы: <strong>${pnum(last.odometer_km)} км</strong> · ${pdt(last.occurred_at)}${last.location?` · ${ph(last.location)}`:''}. Это только справка, значение на границе не рассчитывается автоматически.</div>`:''}
    <form id="periodBoundaryForm" class="form-grid" style="margin-top:14px">
      <div class="field"><label>Одометр на границе</label><input name="odometer" type="number" min="0" step="1" required inputmode="numeric" ${last?`placeholder="не меньше ${ph(last.odometer_km)}"`:''}></div>
      <div class="field"><label>Остаток топлива, л</label><input name="fuel" type="number" min="0" step="0.1" required inputmode="decimal"></div>
      <div class="field"><label>Комментарий <span class="muted">необязательно</span></label><textarea name="notes" placeholder="Источник показаний или пояснение"></textarea></div>
      <button class="primary-btn btn-block" type="submit">Подтвердить состояние</button>
    </form>
  </div>`;
  document.body.appendChild(overlay);
  const form=overlay.querySelector('#periodBoundaryForm');
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const btn=form.querySelector('button[type="submit"]');
    btn.disabled=true;
    try {
      const x=await periodRpc('confirm_reporting_period_boundary',{
        p_period_id:activePeriodReview.period.id,
        p_vehicle_id:task.vehicle_id,
        p_boundary:task.boundary,
        p_odometer_km:Number(form.elements.odometer.value),
        p_fuel_l:Number(form.elements.fuel.value),
        p_notes:form.elements.notes.value||null
      });
      closeBoundaryDialog();
      periodToast('Состояние на границе подтверждено.','success');
      renderPeriodReviewData(x);
    } catch(err) {
      periodToast(friendlyPeriodError(err.message),'error');
    } finally { btn.disabled=false; }
  });
  setTimeout(()=>form.elements.odometer.focus(),50);
}
async function beginPeriodReview(periodId) {
  try {
    const x=await periodRpc('begin_reporting_period_review',{p_period_id:periodId});
    periodToast('Сверка периода начата.','success');
    renderPeriodReviewData(x);
  } catch(e) { periodToast(friendlyPeriodError(e.message),'error'); }
}
async function closePeriod(periodId) {
  if (!window.confirm('Закрыть отчетный период? После закрытия ведомость станет финальной для печати.')) return;
  try {
    const x=await periodRpc('close_reporting_period',{p_period_id:periodId});
    periodToast('Период закрыт. Ведомость готова к печати.','success');
    renderPeriodReviewData(x);
  } catch(e) { periodToast(friendlyPeriodError(e.message),'error'); }
}
async function resolveStatementClick(card,event) {
  const periodId=card.dataset.id;
  let mode=card.dataset.periodMode;
  if (!mode) {
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      const pc=await periodRpc('get_print_center');
      const item=findStatementItem(pc,periodId);
      mode=item?.primary_action?.id||'print_statement';
      card.dataset.periodMode=mode;
      if (mode==='print_statement') card.click();
      else if (mode==='review_period') openPeriodReview(periodId);
      else periodToast(item?.primary_action?.label||'Документ пока недоступен.');
    } catch(e) { periodToast(friendlyPeriodError(e.message),'error'); }
    return;
  }
  if (mode==='review_period') {
    event.preventDefault();
    event.stopImmediatePropagation();
    openPeriodReview(periodId);
  } else if (mode==='none') {
    event.preventDefault();
    event.stopImmediatePropagation();
    periodToast('Этот период пока недоступен.');
  }
}

document.addEventListener('click',e=>{
  const statement=e.target.closest('[data-action="print-statement"]');
  if (statement) {
    resolveStatementClick(statement,e);
    if (e.defaultPrevented) return;
  }
  const action=e.target.closest('[data-period-action]');
  if (!action) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const id=action.dataset.periodAction;
  if (id==='back') document.querySelector('.nav-btn[data-id="print"]')?.click();
  else if (id==='begin') beginPeriodReview(action.dataset.period);
  else if (id==='close') closePeriod(action.dataset.period);
  else if (id==='cancel-boundary') closeBoundaryDialog();
  else if (id==='boundary') {
    const task=(activePeriodReview?.boundary_requests||[]).find(t=>t.id===action.dataset.task);
    if (task) openBoundaryDialog(task);
  }
},true);

document.addEventListener('keydown',e=>{ if (e.key==='Escape') closeBoundaryDialog(); });

let periodScanPending=false;
function periodScan() {
  periodScanPending=false;
  decoratePrintCenter();
}
function schedulePeriodScan() {
  if (periodScanPending) return;
  periodScanPending=true;
  queueMicrotask(periodScan);
}
new MutationObserver(schedulePeriodScan).observe(document.documentElement,{childList:true,subtree:true});
schedulePeriodScan();
