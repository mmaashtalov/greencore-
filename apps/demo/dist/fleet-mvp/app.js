const CFG = {
  url: 'https://tikjmiyrhkcjrxjylmqb.supabase.co',
  key: 'sb_publishable_clr5P9USk7b63MajJmmr9A_Iz0wi_0F',
  version: '2026.08.14-commander-demo'
};

const app = document.getElementById('app');
const SESSION_KEY = 'fleet_mvp_session_v2';
const state = {
  session: loadJSON(SESSION_KEY),
  shell: null,
  view: null,
  params: {},
  data: null,
  stack: [],
  loading: false,
  currentActionForm: null,
  currentPrint: null
};

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function saveSession(s) {
  state.session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function num(v, digits=2) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return esc(v);
  return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:digits}).format(n);
}
function d(v) {
  if (!v) return '—';
  const x = new Date(v); if (Number.isNaN(x.getTime())) return esc(v);
  return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric'}).format(x);
}
function dt(v) {
  if (!v) return '—';
  const x = new Date(v); if (Number.isNaN(x.getTime())) return esc(v);
  return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(x);
}
function onlyTime(v) {
  if (!v) return '';
  const x = new Date(v); if (Number.isNaN(x.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit'}).format(x);
}
function dateTimeLocal(v) {
  const x = v ? new Date(v) : new Date();
  const p = n => String(n).padStart(2,'0');
  return `${x.getFullYear()}-${p(x.getMonth()+1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}
function plusDaysIsoLocal(days) {
  const x = new Date(); x.setDate(x.getDate()+days); return dateTimeLocal(x);
}
function toneClass(t) {
  if (['success','warning','danger','info'].includes(t)) return t;
  return '';
}
function iconFor(id) {
  return ({
    home:'⌂', fleet:'▦', service:'⚙', print:'▤', work:'▶', history:'↺',
    drivers:'♙', incidents:'!', issue_waybill:'+', vehicles:'▦'
  })[id] || '•';
}
function toast(text, type='') {
  let host = document.querySelector('.toast-host');
  if (!host) { host = document.createElement('div'); host.className='toast-host'; document.body.appendChild(host); }
  const el = document.createElement('div'); el.className=`toast ${type}`; el.textContent=text; host.appendChild(el);
  setTimeout(()=>el.remove(), 3600);
}
function errorText(e) {
  const msg = e?.message || String(e || 'Неизвестная ошибка');
  const map = [
    ['Admin role required','Действие доступно только администратору.'],
    ['Authentication required','Нужно войти в систему.'],
    ['Vehicle is not available for operation','Машина сейчас недоступна для эксплуатации.'],
    ['Driver lacks required license category','Категория водительского удостоверения не подходит.'],
    ['Vehicle already has active waybill','У машины уже есть действующий путевой лист.'],
    ['Driver already has active waybill','У водителя уже есть действующий путевой лист.'],
    ['Current fuel norm is not configured','Для машины не задана действующая норма топлива.'],
    ['Waybill cannot be approved','Путевой лист пока нельзя утвердить.'],
    ['Odometer continuity check failed','Не сходится сквозной пробег. Требуется сверка.'],
    ['Fuel continuity check failed','Не сходится остаток топлива. Требуется сверка.']
  ];
  for (const [a,b] of map) if (msg.includes(a)) return b;
  return msg.replace(/^.*ERROR:\s*/,'').split('\n')[0];
}

async function rawAuth(path, body) {
  const res = await fetch(`${CFG.url}${path}`, {
    method:'POST',
    headers:{'apikey':CFG.key,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.msg || data.message || data.error_description || 'Ошибка авторизации');
  return data;
}
async function signIn(email,password) {
  const data = await rawAuth('/auth/v1/token?grant_type=password',{email,password});
  data.obtained_at = Date.now();
  saveSession(data);
  return data;
}
async function refreshSession() {
  if (!state.session?.refresh_token) throw new Error('Сессия истекла');
  const data = await rawAuth('/auth/v1/token?grant_type=refresh_token',{refresh_token:state.session.refresh_token});
  data.obtained_at = Date.now();
  saveSession(data);
  return data;
}
async function ensureFresh() {
  if (!state.session) throw new Error('Authentication required');
  const exp = state.session.expires_at ? state.session.expires_at*1000 : (state.session.obtained_at||Date.now()) + (state.session.expires_in||3600)*1000;
  if (exp - Date.now() < 60000) await refreshSession();
}
async function api(path, options={}, retry=true) {
  await ensureFresh();
  const headers = new Headers(options.headers || {});
  headers.set('apikey',CFG.key);
  headers.set('Authorization',`Bearer ${state.session.access_token}`);
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  const res = await fetch(`${CFG.url}${path}`, {...options,headers});
  if (res.status===401 && retry) {
    await refreshSession();
    return api(path,options,false);
  }
  if (!res.ok) {
    const x = await res.json().catch(()=>({}));
    throw new Error(x.message || x.error || x.hint || `HTTP ${res.status}`);
  }
  if (res.status===204) return null;
  const txt = await res.text();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return txt; }
}
async function rpc(name, params={}) {
  return api(`/rest/v1/rpc/${encodeURIComponent(name)}`, {method:'POST',body:JSON.stringify(params)});
}
async function uploadIncidentEvidence(incidentId,file) {
  const safe = file.name.replace(/[^a-zA-Z0-9А-Яа-я._-]+/g,'_').slice(-80);
  const path = `${incidentId}/${crypto.randomUUID()}-${safe}`;
  await api(`/storage/v1/object/incident-evidence/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method:'POST',
    headers:{'Content-Type':file.type || 'application/octet-stream','x-upsert':'false'},
    body:file
  });
  await rpc('register_incident_evidence',{
    p_incident_id:incidentId,
    p_evidence_type:file.type==='application/pdf'?'pdf':'photo',
    p_storage_path:path,
    p_description:null,
    p_sha256:null
  });
  return path;
}
function logout() {
  saveSession(null); state.shell=null; state.view=null; state.stack=[]; renderLogin();
}

function loadingHTML() { return `<div class="inline-loading"><div class="spinner"></div><span>Загрузка…</span></div>`; }
function emptyHTML(text='Нет данных') { return `<div class="empty">${esc(text)}</div>`; }
function badge(text,tone='') { return `<span class="badge ${toneClass(tone)}">${esc(text)}</span>`; }
function alertHTML(item) {
  return `<div class="alert ${toneClass(item.tone)}">
    <div><strong>${item.tone==='danger'?'!':item.tone==='warning'?'△':'•'}</strong></div>
    <div style="flex:1"><div class="alert-title">${esc(item.label||item.title||'Внимание')}${item.count!=null?` · ${num(item.count,0)}`:''}</div>
    ${item.detail||item.body?`<div class="alert-sub">${esc(item.detail||item.body)}</div>`:''}</div>
  </div>`;
}
function button(label, action, opts={}) {
  const cls=opts.kind==='primary'?'primary-btn':opts.kind==='danger'?'danger-btn':opts.kind==='soft'?'soft-btn':'ghost-btn';
  const attrs = Object.entries(opts.data||{}).map(([k,v])=>` data-${k}="${esc(v)}"`).join('');
  return `<button class="${cls}${opts.block?' btn-block':''}" data-action="${esc(action)}"${attrs}${opts.disabled?' disabled':''}>${esc(label)}</button>`;
}
function pageHead(title,subtitle='',back=true,actions='') {
  return `<div class="page-head">
    ${back?'<button class="back-btn" data-action="back" aria-label="Назад">‹</button>':''}
    <div class="page-title-wrap"><h1 class="page-title">${esc(title)}</h1>${subtitle?`<p class="page-subtitle">${esc(subtitle)}</p>`:''}</div>
    ${actions?`<div class="page-actions">${actions}</div>`:''}
  </div>`;
}
function roleLabel() { return state.shell?.role==='admin'?'Администратор':'Водитель'; }
function renderShell(content,title='',mainId=null) {
  const nav = state.shell?.navigation || [];
  const currentMain = mainId || inferMain(state.view);
  const navButtons = nav.map(n=>`<button class="nav-btn ${currentMain===n.id?'active':''}" data-action="main-nav" data-id="${esc(n.id)}">
    <span class="nav-icon">${iconFor(n.id)}</span>${esc(n.label)}</button>`).join('');
  app.innerHTML = `<div class="app-shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark">АТ</div><div class="brand-text"><div class="brand-title">АСУ Автопарк</div><div class="brand-sub">MVP · синтетические данные · ${esc(roleLabel())}</div></div></div>
      <nav class="desktop-nav">${navButtons}</nav>
      <div class="topbar-actions"><button class="icon-btn" data-action="refresh" title="Обновить">↻</button><button class="icon-btn" data-action="logout" title="Выйти">⎋</button></div>
    </header>
    <main class="main">${content}</main>
    <nav class="bottom-nav">${navButtons}</nav>
  </div>`;
}
function inferMain(view) {
  if (!state.shell) return '';
  if (state.shell.role==='driver') return view==='driverHistory'?'history':'work';
  if (['fleet','vehicle','drivers','driver','createVehicle','createDriver','assignment','incidents','incident','package','uploadEvidence'].includes(view)) return 'fleet';
  if (['service','repair','maintenance'].includes(view)) return 'service';
  if (['print','waybillPrint','statementPrint','reviewQueue','waybillReview','issueWaybill'].includes(view)) return 'print';
  return 'home';
}

function renderLogin() {
  app.innerHTML = `<div class="login-wrap">
    <form class="login-card" id="loginForm">
      <div class="login-logo"><div class="brand-mark">АТ</div><div><div class="login-title">АСУ Автопарк</div><div class="login-sub">Демонстрационный MVP</div></div></div>
      <div class="form-grid">
        <div class="field"><label for="email">Логин</label><input id="email" name="email" type="email" autocomplete="username" value="fleet.admin@example.com" required></div>
        <div class="field"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Введите пароль" required></div>
        <button class="primary-btn btn-block" type="submit">Войти</button>
      </div>
      <div class="demo-note"><strong>Демо-контур.</strong> В системе только синтетические данные. Интерфейс водителя и администратора разделены по ролям.</div>
      <div id="loginError" class="alert danger" style="display:none;margin-top:12px"></div>
    </form>
  </div>`;
  document.getElementById('loginForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd=new FormData(e.currentTarget);
    const btn=e.currentTarget.querySelector('button[type=submit]');
    btn.disabled=true; btn.textContent='Вход…';
    try {
      await signIn(fd.get('email'),fd.get('password'));
      await bootstrap();
    } catch(err) {
      const box=document.getElementById('loginError'); box.style.display='block'; box.textContent=errorText(err);
    } finally { btn.disabled=false; btn.textContent='Войти'; }
  });
}

async function bootstrap() {
  try {
    state.shell = await rpc('get_app_shell');
    state.stack=[];
    if (state.shell.role==='admin') await navigate('home',{}, {replace:true,reset:true});
    else await navigate('driverWork',{}, {replace:true,reset:true});
  } catch(err) {
    if (String(err.message).toLowerCase().includes('jwt') || String(err.message).includes('Authentication')) {
      logout(); return;
    }
    renderShell(`${pageHead('Ошибка','',false)}<div class="alert danger"><div>!</div><div>${esc(errorText(err))}</div></div>`);
  }
}

async function navigate(view, params={}, opts={}) {
  if (state.loading) return;
  if (!opts.replace && state.view && !opts.reset) state.stack.push({view:state.view,params:state.params});
  if (opts.reset) state.stack=[];
  state.view=view; state.params=params; state.loading=true;
  renderShell(`${pageHead(viewTitle(view),'',state.stack.length>0)}${loadingHTML()}`);
  try {
    state.data = await loadView(view,params);
    renderCurrent();
  } catch(err) {
    renderShell(`${pageHead(viewTitle(view),'',state.stack.length>0)}<div class="alert danger"><div>!</div><div><div class="alert-title">Не удалось загрузить экран</div><div class="alert-sub">${esc(errorText(err))}</div></div></div>`);
  } finally { state.loading=false; }
}
async function goBack() {
  const prev=state.stack.pop();
  if (!prev) {
    return state.shell?.role==='admin' ? navigate('home',{}, {replace:true,reset:true}) : navigate('driverWork',{}, {replace:true,reset:true});
  }
  state.view=prev.view; state.params=prev.params; state.loading=true;
  renderShell(`${pageHead(viewTitle(state.view),'',state.stack.length>0)}${loadingHTML()}`);
  try { state.data=await loadView(state.view,state.params); renderCurrent(); }
  catch(err){ toast(errorText(err),'error'); }
  finally{state.loading=false;}
}
function viewTitle(v) {
  return ({
    home:'Главная',fleet:'Техника',vehicle:'Карточка машины',drivers:'Водители',driver:'Карточка водителя',
    service:'ТО и ремонт',repair:'Ремонт',maintenance:'Техническое обслуживание',incidents:'Происшествия',
    incident:'Происшествие',package:'Документы',print:'Печать',waybillPrint:'Путевой лист',
    statementPrint:'Сводная ведомость',reviewQueue:'Проверка ПЛ',waybillReview:'Путевой лист',
    issueWaybill:'Выдать ПЛ',createVehicle:'Добавить технику',createDriver:'Добавить водителя',
    assignment:'Закрепить водителя',driverWork:'Работа',driverHistory:'История',driverAction:'Действие',
    uploadEvidence:'Подтверждение',newIncident:'Новое происшествие',repairAssessment:'Результат диагностики',maintenanceComplete:'ТО выполнено'
  })[v] || 'Автопарк';
}
async function loadView(view,p) {
  switch(view) {
    case 'home': return rpc('get_admin_home');
    case 'fleet': return rpc('get_fleet_list_ui');
    case 'vehicle': return rpc('get_vehicle_card',{p_vehicle_id:p.id});
    case 'drivers': return rpc('get_drivers_list_ui');
    case 'driver': return rpc('get_driver_card',{p_driver_id:p.id});
    case 'service': return rpc('get_service_center');
    case 'repair': return rpc('get_repair_case_card',{p_case_id:p.id});
    case 'maintenance': return rpc('get_maintenance_card',{p_rule_id:p.id});
    case 'incidents': return rpc('get_incidents_ui');
    case 'incident': return rpc('get_incident_ui_contract',{p_incident_id:p.id});
    case 'package': return rpc('get_document_package_ui',{p_package_id:p.id});
    case 'print': return rpc('get_print_center');
    case 'reviewQueue': return rpc('get_waybill_review_queue');
    case 'waybillReview': return rpc('get_waybill_review_card',{p_waybill_id:p.id});
    case 'waybillPrint': return rpc('get_waybill_print_package',{p_waybill_id:p.id});
    case 'statementPrint': return rpc('get_fleet_statement_print_package',{p_reporting_period_id:p.id}).catch(()=>rpc('get_fleet_statement_print_package',{p_period_id:p.id}));
    case 'issueWaybill': return rpc('get_waybill_issue_form');
    case 'createVehicle': return rpc('get_vehicle_create_form');
    case 'createDriver': return rpc('get_driver_create_form');
    case 'assignment': return rpc('get_assignment_form',{p_vehicle_id:p.vehicleId||null});
    case 'driverWork': return rpc('get_driver_home');
    case 'driverHistory': return rpc('get_driver_history_ui');
    case 'driverAction': return rpc('get_driver_action_form',{p_action:p.action,p_waybill_id:p.waybillId});
    case 'uploadEvidence': return {incidentId:p.incidentId, packageId:p.packageId};
    case 'newIncident': return rpc('get_incident_create_form');
    case 'repairAssessment': return rpc('get_repair_case_card',{p_case_id:p.id});
    case 'maintenanceComplete': return rpc('get_maintenance_card',{p_rule_id:p.id});
    default: return null;
  }
}
function renderCurrent() {
  const v=state.view, x=state.data;
  const renderers={
    home:renderHome,fleet:renderFleet,vehicle:renderVehicle,drivers:renderDrivers,driver:renderDriver,
    service:renderService,repair:renderRepair,maintenance:renderMaintenance,incidents:renderIncidents,
    incident:renderIncident,package:renderPackage,print:renderPrintCenter,reviewQueue:renderReviewQueue,
    waybillReview:renderWaybillReview,waybillPrint:renderWaybillPrint,statementPrint:renderStatementPrint,
    issueWaybill:renderIssueWaybill,createVehicle:renderCreateVehicle,createDriver:renderCreateDriver,
    assignment:renderAssignment,driverWork:renderDriverWork,driverHistory:renderDriverHistory,
    driverAction:renderDriverAction,uploadEvidence:renderUploadEvidence,newIncident:renderNewIncident,repairAssessment:renderRepairAssessment,maintenanceComplete:renderMaintenanceComplete
  };
  const fn=renderers[v];
  renderShell(fn?fn(x):emptyHTML('Экран не найден'),viewTitle(v),inferMain(v));
}

function renderHome(x) {
  const f=x.fleet||{}, w=x.waybills||{}, inc=x.incidents||{};
  const att=(x.attention||[]).map(a=>`<div class="card clickable" data-action="attention" data-id="${esc(a.id)}">
    <div class="card-head"><div><div class="card-title">${esc(a.label)}</div><div class="card-sub">Требует решения</div></div>${badge(a.count,a.tone)}</div></div>`).join('');
  return `${pageHead(x.headline||'Автопарк','Состояние техники и то, что требует внимания.',false)}
    <div class="grid grid-4">
      <div class="metric"><div class="metric-value">${num(f.total,0)}</div><div class="metric-label">Всего техники</div></div>
      <div class="metric"><div class="metric-value">${num(f.operational,0)}</div><div class="metric-label">В эксплуатации</div></div>
      <div class="metric"><div class="metric-value">${num(f.repair,0)}</div><div class="metric-label">В ремонте</div></div>
      <div class="metric"><div class="metric-value">${num(f.unavailable,0)}</div><div class="metric-label">Недоступно</div></div>
    </div>
    <section class="section"><h2 class="section-title">Требует внимания <span class="badge ${x.attention_total?'warning':''}">${num(x.attention_total,0)}</span></h2>
      <div class="attention-grid">${att||emptyHTML('Сейчас нет задач, требующих решения.')}</div>
    </section>
    <section class="section"><h2 class="section-title">Путевые листы</h2>
      <div class="grid grid-3">
        <div class="card"><div class="metric-value">${num(w.active,0)}</div><div class="card-sub">В работе</div></div>
        <div class="card clickable" data-action="open-review-queue"><div class="metric-value">${num(w.waiting_review,0)}</div><div class="card-sub">Ждут проверки</div></div>
        <div class="card"><div class="metric-value">${num(w.needs_correction,0)}</div><div class="card-sub">На исправлении</div></div>
      </div>
    </section>
    <section class="section"><h2 class="section-title">Быстрые действия</h2>
      <div class="quick-actions">
        <button class="quick-btn" data-action="issue-waybill"><strong>＋</strong>Выдать ПЛ</button>
        <button class="quick-btn" data-action="main-nav" data-id="print"><strong>▤</strong>Печать</button>
        <button class="quick-btn" data-action="main-nav" data-id="fleet"><strong>▦</strong>Техника</button>
      </div>
    </section>
    <section class="section"><div class="card"><div class="card-title">Отчетный период</div><div class="card-sub">${esc(x.current_period?.label||'Не задан')}</div>
      <div class="action-row">${button('Открыть печать','main-nav',{kind:'soft',data:{id:'print'}})}</div></div></section>`;
}
function renderFleet(x) {
  const s=x.summary||{};
  const items=(x.items||[]).map(i=>`<div class="list-item clickable" data-action="open-vehicle" data-id="${esc(i.id)}">
    <div class="list-main"><div class="list-title">${esc(i.label)}</div><div class="list-sub">${esc(i.subtitle||'')}${i.active_waybill?` · ПЛ ${esc(i.active_waybill.number)}`:''}</div>
      ${i.attention?`<div style="margin-top:6px">${badge(i.attention,i.tone)}</div>`:''}</div>
    <div class="list-side">${badge(i.status_label,i.tone)}<div class="chev">›</div></div></div>`).join('');
  return `${pageHead('Техника','Сначала машины, которые требуют решения.',false,
    button('Добавить','add-vehicle',{kind:'primary'}))}
    <div class="grid grid-4">
      <div class="metric"><div class="metric-value">${num(s.total,0)}</div><div class="metric-label">Всего</div></div>
      <div class="metric"><div class="metric-value">${num(s.operational,0)}</div><div class="metric-label">В эксплуатации</div></div>
      <div class="metric"><div class="metric-value">${num(s.repair,0)}</div><div class="metric-label">Ремонт</div></div>
      <div class="metric"><div class="metric-value">${num(s.unavailable,0)}</div><div class="metric-label">Недоступно</div></div>
    </div>
    <div class="action-row no-print">${button('Водители','open-drivers',{kind:'soft'})}${button('Происшествия','open-incidents',{kind:'soft'})}</div>
    <section class="section"><div class="list">${items||emptyHTML('Техника не добавлена.')}</div></section>`;
}
function renderVehicle(x) {
  const att=(x.attention||[]).map(alertHTML).join('');
  const wb=x.active_waybill;
  const sections=(x.sections||[]).map(s=>`<details ${!s.collapsed?'open':''}><summary>${esc(s.label)}${s.count!=null?` · ${num(s.count,0)}`:''}</summary>
    <div>${s.id==='waybills'?(s.preview||[]).map(w=>`<div class="list-item clickable" data-action="open-waybill-review" data-id="${esc(w.id)}"><div class="list-main"><div class="list-title">${esc(w.number)}</div><div class="list-sub">${d(w.valid_from)}–${d(w.valid_to)}</div></div>${badge(w.status_label)}</div>`).join('')||emptyHTML('Путевых листов нет'):
    s.id==='service'?`<div class="kv"><div class="kv-row"><span class="kv-label">Открытых ремонтов</span><span class="kv-value">${num(s.summary?.open_repairs,0)}</span></div><div class="kv-row"><span class="kv-label">Предупреждений ТО</span><span class="kv-value">${num(s.summary?.maintenance_alerts,0)}</span></div></div>${button('Открыть ТО и ремонт','main-nav',{kind:'soft',data:{id:'service'},block:true})}`:
    s.id==='incidents'?button('Открыть происшествия','open-incidents',{kind:'soft',block:true}):
    `<div class="kv"><div class="kv-row"><span class="kv-label">Номер</span><span class="kv-value">${esc(x.subtitle||'—')}</span></div></div>`}</div></details>`).join('');
  const pa=x.primary_action||{};
  return `${pageHead(x.title||'Машина',x.subtitle||'',true)}
    <div class="hero"><div class="card-head"><div><div class="muted">Статус</div><h2>${esc(x.status_label)}</h2></div>${badge(x.status_label,x.status_tone)}</div>
      <div class="grid grid-3" style="margin-top:16px">
        <div><div class="muted small">Пробег</div><strong>${num(x.current?.odometer_km,0)} км</strong></div>
        <div><div class="muted small">Топливо</div><strong>${num(x.current?.fuel_l)} ${esc(x.current?.fuel_label||'')}</strong></div>
        <div><div class="muted small">ПЛ</div><strong>${wb?esc(wb.number):'нет'}</strong></div>
      </div>
      ${pa.enabled?`<div class="action-row">${vehiclePrimaryButton(pa,x.id)}</div>`:''}
    </div>
    ${att?`<section class="section"><h2 class="section-title">Внимание</h2><div class="attention-grid">${att}</div></section>`:''}
    <section class="section"><div class="grid">${sections}</div></section>
    <div class="action-row no-print">${button('Закрепить водителя','assignment',{kind:'soft',data:{vehicle:x.id}})}${button('Печать / ПЛ','vehicle-print',{kind:'soft',data:{waybill:wb?.id||''},disabled:!wb})}</div>`;
}
function vehiclePrimaryButton(pa,vehicleId) {
  if (pa.id==='open_waybill') return button(pa.label,'open-waybill-review',{kind:'primary',data:{id:pa.target_id}});
  if (pa.id==='open_repair') return button(pa.label,'open-repair',{kind:'primary',data:{id:pa.target_id}});
  if (pa.id==='open_incident') return button(pa.label,'open-incident',{kind:'primary',data:{id:pa.target_id}});
  if (pa.id==='open_maintenance') return button(pa.label,'open-maintenance',{kind:'primary',data:{id:pa.target_id}});
  if (pa.id==='issue_waybill') return button(pa.label,'issue-waybill',{kind:'primary',data:{vehicle:vehicleId}});
  return '';
}
function renderDrivers(x) {
  const items=(x.items||[]).map(i=>`<div class="list-item clickable" data-action="open-driver" data-id="${esc(i.id)}">
    <div class="list-main"><div class="list-title">${esc(i.rank?`${i.rank} `:'')}${esc(i.name)}</div>
      <div class="list-sub">Категории: ${(i.categories||[]).map(esc).join(', ')||'—'}${i.assigned_vehicle?` · ${esc(i.assigned_vehicle.label)}`:''}</div>
      ${i.attention?`<div style="margin-top:5px">${badge(i.attention,'warning')}</div>`:''}</div><div class="chev">›</div></div>`).join('');
  return `${pageHead('Водители','Категории допуска и закрепленная техника.',true,button('Добавить','add-driver',{kind:'primary'}))}
    <div class="list">${items||emptyHTML('Водители не добавлены.')}</div>`;
}
function renderDriver(x) {
  const hist=(x.history||[]).map(w=>`<div class="list-item clickable" data-action="open-waybill-review" data-id="${esc(w.id)}"><div class="list-main"><div class="list-title">${esc(w.number)} · ${esc(w.vehicle)}</div><div class="list-sub">${d(w.from)}–${d(w.to)}</div></div>${badge(w.status_label)}</div>`).join('');
  return `${pageHead(x.title||'Водитель',x.subtitle||'',true)}
    <div class="card"><div class="kv">
      <div class="kv-row"><span class="kv-label">Категории</span><span class="kv-value">${(x.categories||[]).join(', ')||'—'}</span></div>
      <div class="kv-row"><span class="kv-label">Закрепленная машина</span><span class="kv-value">${esc(x.assigned_vehicle?.label||'Не закреплена')}</span></div>
      <div class="kv-row"><span class="kv-label">Удостоверение до</span><span class="kv-value">${d(x.license_valid_to)}</span></div>
      <div class="kv-row"><span class="kv-label">Активный ПЛ</span><span class="kv-value">${esc(x.active_waybill?.number||'нет')}</span></div>
    </div></div>
    <section class="section"><h2 class="section-title">Последние путевые листы</h2><div class="list">${hist||emptyHTML()}</div></section>`;
}
function renderService(x) {
  const items=(x.attention||[]).map(i=>`<div class="list-item clickable" data-action="service-item" data-type="${esc(i.type)}" data-id="${esc(String(i.id||'').split(':').pop())}">
    <div class="list-main"><div class="list-title">${esc(i.vehicle||'')}</div><div class="list-sub">${esc(i.label||'')} · ${esc(i.detail||'')}</div></div>${badge(i.label,i.tone)}<div class="chev">›</div></div>`).join('');
  return `${pageHead(x.title||'ТО и ремонт',x.subtitle||'',false)}
    <div class="grid grid-3"><div class="metric"><div class="metric-value">${num(x.counters?.maintenance_due,0)}</div><div class="metric-label">Скоро ТО</div></div>
    <div class="metric"><div class="metric-value">${num(x.counters?.in_repair,0)}</div><div class="metric-label">В ремонте</div></div>
    <div class="metric"><div class="metric-value">${num(x.counters?.new_defects,0)}</div><div class="metric-label">Новых неисправностей</div></div></div>
    <section class="section"><h2 class="section-title">Требует внимания</h2><div class="list">${items||emptyHTML('Нет задач по ТО и ремонту.')}</div></section>`;
}
function renderRepair(x) {
  const a=x.assessment||{};
  return `${pageHead('Ремонт',`${x.vehicle?.label||''} №${x.vehicle?.number||''}`,true)}
    <div class="hero"><div class="muted">Этап</div><h2>${esc(x.stage_label)}</h2><div class="muted small">Открыт ${dt(x.opened_at)}</div></div>
    <section class="section"><div class="card"><div class="card-title">Диагностика</div><div class="kv">
      <div class="kv-row"><span class="kv-label">Диагноз</span><span class="kv-value">${esc(a.diagnosis||'Не заполнен')}</span></div>
      <div class="kv-row"><span class="kv-label">Причина</span><span class="kv-value">${esc(a.root_cause||'Не определена')}</span></div>
      <div class="kv-row"><span class="kv-label">Предотвращаемость</span><span class="kv-value">${esc(a.preventability_label||'Не определено')}</span></div>
      <div class="kv-row"><span class="kv-label">Профилактика</span><span class="kv-value">${esc(a.preventive_action||'—')}</span></div>
    </div></div></section>
    <div class="action-row">${x.primary_action?.enabled?button(x.primary_action.label,'repair-action',{kind:'primary',data:{id:x.id,'repair-action':x.primary_action.id}}):''}
      ${(x.secondary_actions||[]).map(a=>button(a.label,'repair-action',{kind:'soft',data:{id:x.id,'repair-action':a.id}})).join('')}</div>`;
}
function renderMaintenance(x) {
  return `${pageHead(x.title||'ТО',`${x.vehicle?.label||''} №${x.vehicle?.number||''}`,true)}
    <div class="hero"><div class="muted">Состояние</div><h2>${esc(x.status_label)}</h2>
      <div class="grid grid-3" style="margin-top:14px"><div><div class="muted small">Пробег</div><strong>${num(x.current?.odometer_km,0)} км</strong></div>
      <div><div class="muted small">До ТО</div><strong>${num(x.next_due?.remaining_km,0)} км</strong></div>
      <div><div class="muted small">Дата</div><strong>${d(x.next_due?.date)}</strong></div></div></div>
    <section class="section"><div class="card"><div class="card-title">Последнее обслуживание</div><div class="card-sub">${d(x.last_service?.performed_at)} · ${num(x.last_service?.odometer_km,0)} км</div></div></section>
    ${x.primary_action?.enabled?`<div class="action-row">${button(x.primary_action.label,'complete-maintenance',{kind:'primary',data:{id:x.rule_id}})}</div>`:''}`;
}
function renderIncidents(x) {
  const one=i=>`<div class="list-item clickable" data-action="open-incident" data-id="${esc(i.id)}"><div class="list-main"><div class="list-title">${esc(i.vehicle)}</div><div class="list-sub">${dt(i.occurred_at)} · ${esc(i.status_label)}</div></div><div class="chev">›</div></div>`;
  return `${pageHead(x.title||'Происшествия','Сначала то, что требует решения.',true,button('Зафиксировать','new-incident',{kind:'primary'}))}
    <section><h2 class="section-title">Требует внимания</h2><div class="list">${(x.attention||[]).map(one).join('')||emptyHTML('Нет нерешенных происшествий.')}</div></section>
    <section class="section"><h2 class="section-title">Недавние</h2><div class="list">${(x.recent||[]).map(one).join('')||emptyHTML()}</div></section>`;
}
function renderIncident(x) {
  const choices=(x.condition_choices||[]).map(c=>`<button class="choice" data-action="set-incident-condition" data-id="${esc(x.id)}" data-value="${esc(c.value)}">${esc(c.label)}</button>`).join('');
  const packages=(x.packages||[]).map(p=>`<div class="list-item clickable" data-action="open-package" data-id="${esc(p.id)}" data-incident="${esc(x.id)}"><div class="list-main"><div class="list-title">${packageLabel(p.type)}</div><div class="list-sub">${esc(p.status)}</div></div><div class="chev">›</div></div>`).join('');
  return `${pageHead(x.title||'Происшествие',dt(x.occurred_at),true)}
    <div class="card"><div class="card-head"><div><div class="card-title">${esc(x.vehicle?.label||'')}</div><div class="card-sub">${esc(x.location||'Место не указано')}</div></div>${badge(x.status_label,x.vehicle?.status==='destroyed'?'danger':'warning')}</div>
      <hr class="sep"><p>${esc(x.description||'')}</p>
      <div class="kv" style="margin-top:12px"><div class="kv-row"><span class="kv-label">Состояние</span><span class="kv-value">${esc(x.outcome_label)}</span></div>
      <div class="kv-row"><span class="kv-label">Последний пробег</span><span class="kv-value">${num(x.last_confirmed?.odometer_km,0)} км</span></div>
      <div class="kv-row"><span class="kv-label">Последнее топливо</span><span class="kv-value">${num(x.last_confirmed?.fuel_l)} л</span></div></div>
    </div>
    ${choices?`<section class="section"><h2 class="section-title">Указать состояние техники</h2><div class="choice-grid">${choices}</div></section>`:''}
    <section class="section"><h2 class="section-title">Документы</h2><div class="list">${packages||emptyHTML('Пакеты документов еще не созданы.')}</div></section>
    <div class="action-row">${button('Добавить подтверждение','upload-evidence',{kind:'soft',data:{incident:x.id,package:(x.packages||[])[0]?.id||''}})}</div>`;
}
function packageLabel(t) {
  return ({INCIDENT_PACKAGE:'Материалы по происшествию',REPAIR_PACKAGE:'Материалы по ремонту',VEHICLE_LOSS_PACKAGE:'Материалы по утрате техники',WRITE_OFF_PACKAGE:'Материалы на списание',MAINTENANCE_PACKAGE:'Материалы по ТО'})[t] || 'Документы';
}
function renderPackage(x) {
  const checks=(x.checklist||[]).map(c=>`<div class="list-item"><div class="list-main"><div class="list-title">${c.done?'✓':'○'} ${esc(c.label)}</div>${c.count!=null?`<div class="list-sub">${num(c.count,0)} файл(а)</div>`:''}</div>${badge(c.done?'Готово':c.required?'Нужно':'Необязательно',c.done?'success':c.required?'warning':'')}</div>`).join('');
  const pa=x.primary_action||{};
  return `${pageHead(x.title||'Документы',x.vehicle?.label||'',true)}
    <div class="card"><div class="card-head"><div><div class="card-title">${esc(x.status_label)}</div><div class="card-sub">${esc(x.subtitle||'')}</div></div>${badge(x.data_ready?'Данные собраны':'Не готово',x.data_ready?'success':'warning')}</div></div>
    <section class="section"><div class="list">${checks}</div></section>
    ${x.missing?.length?`<section class="section"><div class="alert warning"><div>△</div><div><div class="alert-title">Не хватает</div><div class="alert-sub">${x.missing.map(esc).join(', ')}</div></div></div></section>`:''}
    <div class="action-row">${pa.id==='prepare'?button(pa.label,'prepare-package',{kind:'primary',data:{id:x.id}}):''}
      ${pa.id==='add_evidence'?button(pa.label,'upload-evidence',{kind:'primary',data:{incident:state.params.incidentId||'',package:x.id}}):''}</div>`;
}
function renderPrintCenter(x) {
  const wb=(x.sections||[]).find(s=>s.id==='waybills');
  const st=(x.sections||[]).find(s=>s.id==='statements');
  return `${pageHead(x.title||'Печать',x.subtitle||'',false)}
    <section><h2 class="section-title">Путевые листы <span class="badge">${num(wb?.total_count,0)}</span></h2><div class="list">
      ${(wb?.items||[]).map(i=>`<div class="list-item clickable" data-action="print-waybill" data-id="${esc(i.id)}"><div class="list-main"><div class="list-title">${esc(i.number)} · ${esc(i.vehicle)}</div><div class="list-sub">${esc(i.driver)} · ${d(i.period?.from)}–${d(i.period?.to)}</div></div>${badge(i.status_label,i.print_mode==='final'?'success':'info')}<div class="chev">›</div></div>`).join('')||emptyHTML()}
    </div></section>
    <section class="section"><h2 class="section-title">Сводные ведомости</h2><div class="list">
      ${(st?.items||[]).map(i=>`<div class="list-item clickable" data-action="print-statement" data-id="${esc(i.id)}"><div class="list-main"><div class="list-title">${esc(i.label)}</div><div class="list-sub">${num(i.vehicle_count,0)} машин · ${num(i.page_count,0)} стр.${i.blocking_issues_count?` · проблем: ${num(i.blocking_issues_count,0)}`:''}</div></div>${badge(i.status_label,i.ready_for_print?'success':i.primary_action?.enabled?'warning':'')}<div class="chev">›</div></div>`).join('')||emptyHTML()}
    </div></section>
    <div class="action-row no-print">${button('Проверка ПЛ','open-review-queue',{kind:'soft'})}${button('Выдать ПЛ','issue-waybill',{kind:'primary'})}</div>`;
}
function renderReviewQueue(x) {
  const items=(x.items||[]).map(i=>`<div class="list-item clickable" data-action="open-waybill-review" data-id="${esc(i.id)}"><div class="list-main"><div class="list-title">${esc(i.number||'ПЛ')} · ${esc(i.vehicle||'')}</div><div class="list-sub">${esc(i.driver||'')} · ${esc(i.status_label||'')}</div></div><div class="chev">›</div></div>`).join('');
  return `${pageHead(x.title||'Проверка путевых листов',x.subtitle||'',true)}<div class="list">${items||emptyHTML('Сейчас нет путевых листов, ожидающих проверки.')}</div>`;
}
function renderWaybillReview(x) {
  const s=x.summary||{};
  const warnings=(x.warnings||[]).map(alertHTML).join('');
  const canApprove=x.primary_action?.id==='approve' && x.primary_action?.enabled;
  return `${pageHead(`ПЛ ${x.number||''}`,`${x.vehicle?.label||''} №${x.vehicle?.internal_number||''} · ${x.driver?.full_name||''}`,true)}
    <div class="card"><div class="card-head"><div><div class="card-title">${esc(x.status_label)}</div><div class="card-sub">${d(x.period?.from)}–${d(x.period?.to)}</div></div>${badge(x.status_label,x.status==='approved'?'success':x.status==='needs_correction'?'warning':'info')}</div>
      <div class="grid grid-3" style="margin-top:15px">
        <div class="metric"><div class="metric-value">${num(s.mileage_km,0)}</div><div class="metric-label">Пробег, км</div></div>
        <div class="metric"><div class="metric-value">${num(s.actual_consumption_l)}</div><div class="metric-label">Факт. расход, л</div></div>
        <div class="metric"><div class="metric-value">${num(s.variance_l)}</div><div class="metric-label">Отклонение, л</div></div>
      </div>
      <div class="kv" style="margin-top:12px">
        <div class="kv-row"><span class="kv-label">Одометр</span><span class="kv-value">${num(s.opening_odometer_km,0)} → ${num(s.closing_odometer_km,0)}</span></div>
        <div class="kv-row"><span class="kv-label">Топливо</span><span class="kv-value">${num(s.opening_fuel_l)} + ${num(s.fuel_received_l)} → ${num(s.closing_fuel_l)} л</span></div>
        <div class="kv-row"><span class="kv-label">По норме</span><span class="kv-value">${num(s.normative_consumption_l)} л</span></div>
        <div class="kv-row"><span class="kv-label">Заправок</span><span class="kv-value">${num(s.refuel_count,0)}</span></div>
      </div>
    </div>
    ${warnings?`<section class="section"><div class="attention-grid">${warnings}</div></section>`:''}
    <div class="action-row no-print">
      ${x.primary_action?.id==='review'?button(x.primary_action.label,'begin-review',{kind:'primary',data:{id:x.id}}):''}
      ${canApprove?button('Утвердить ПЛ','approve-waybill',{kind:'primary',data:{id:x.id}}):''}
      ${x.status==='under_review'?button('Вернуть на исправление','return-correction',{kind:'soft',data:{id:x.id}}):''}
      ${button('Предпросмотр печати','print-waybill',{kind:'soft',data:{id:x.id}})}
    </div>`;
}
function renderDriverWork(x) {
  const w=x.waybill, v=x.vehicle, pa=x.primary_action||{};
  if (!w) return `${pageHead('Моя машина',x.user?.full_name||'',false)}<div class="hero"><div class="muted">Путевой лист</div><h2>Нет активного ПЛ</h2><p class="muted">Ожидайте выдачи путевого листа.</p></div><div class="action-row">${button('История','main-nav',{kind:'soft',data:{id:'history'}})}</div>`;
  return `${pageHead('Моя машина',x.user?.full_name||'',false)}
    <div class="hero"><div class="card-head"><div><div class="muted">Техника</div><h2>${esc(v?.title||'')}</h2><div class="muted">${esc(v?.registration_number||'')} · №${esc(v?.internal_number||'')}</div></div>${badge(w.status_label,'info')}</div>
      <div class="grid grid-3" style="margin-top:18px">
        <div><div class="muted small">ПЛ</div><strong>${esc(w.number)}</strong></div>
        <div><div class="muted small">Одометр</div><strong>${num(w.last_odometer_km,0)} км</strong></div>
        <div><div class="muted small">Место</div><strong>${esc(w.last_location||'Парк')}</strong></div>
      </div>
      <div class="action-row">${pa.enabled?button(pa.label,'driver-action',{kind:'primary',data:{'driver-action':pa.id,waybill:w.id}}):''}</div>
    </div>
    <div class="action-row">${(x.secondary_actions||[]).map(a=>button(a.label,'driver-action',{kind:a.id==='report_defect'?'soft':'soft',data:{'driver-action':a.id,waybill:w.id}})).join('')}</div>
    <section class="section"><div class="grid grid-3">
      <div class="metric"><div class="metric-value">${num(w.route_points,0)}</div><div class="metric-label">Маршрутных точек</div></div>
      <div class="metric"><div class="metric-value">${num(w.refuel_count,0)}</div><div class="metric-label">Заправок</div></div>
      <div class="metric"><div class="metric-value">${num(w.fuel_received_l)}</div><div class="metric-label">Получено, л</div></div>
    </div></section>`;
}
function renderDriverHistory(x) {
  const items=(x.items||[]).map(i=>`<div class="list-item"><div class="list-main"><div class="list-title">${esc(i.number)} · ${esc(i.vehicle)}</div><div class="list-sub">${d(i.period?.from)}–${d(i.period?.to)} · ${num(i.mileage_km,0)} км · ${num(i.fuel_received_l)} л</div></div>${badge(i.status_label)}</div>`).join('');
  return `${pageHead(x.title||'История',x.subtitle||'',false)}<div class="list">${items||emptyHTML()}</div>`;
}
function renderDriverAction(x) {
  state.currentActionForm=x;
  const fields=(x.fields||[]).map(renderDynamicField).join('');
  return `${pageHead(x.title||'Действие','Время события будет записано автоматически.',true)}
    <form class="form-card" id="driverActionForm"><div class="form-grid">${fields}</div>
      <div class="action-row"><button class="primary-btn btn-block" type="submit">${esc(x.submit?.label||'Сохранить')}</button></div>
    </form>`;
}
function renderDynamicField(f) {
  const def=f.default??'';
  if (f.control==='textarea') return `<div class="field"><label>${esc(f.label)}</label><textarea name="${esc(f.id)}" ${f.required?'required':''}>${esc(def)}</textarea></div>`;
  if (f.control==='choice') return `<div class="field"><label>${esc(f.label)}</label><select name="${esc(f.id)}" ${f.required?'required':''}><option value="">Выберите</option>${(f.choices||[]).map(c=>`<option value="${esc(c.value)}">${esc(c.label)}</option>`).join('')}</select></div>`;
  const type=f.input==='number'?'number':'text';
  return `<div class="field"><label>${esc(f.label)}</label><input type="${type}" step="${type==='number'?'any':''}" name="${esc(f.id)}" value="${esc(def)}" ${f.required?'required':''}></div>`;
}

function renderIssueWaybill(x) {
  const vehicleId=state.params.vehicle||'';
  const options=(x.vehicles||[]).map(v=>`<option value="${esc(v.id)}" ${v.id===vehicleId?'selected':''}>${esc(v.label)}</option>`).join('');
  const drivers=(x.drivers||[]).map(v=>`<option value="${esc(v.id)}">${esc(v.rank?`${v.rank} `:'')}${esc(v.label)} · ${(v.categories||[]).join(',')}</option>`).join('');
  return `${pageHead(x.title||'Выдать путевой лист',x.subtitle||'',true)}
    <form class="form-card" id="issueForm"><div class="form-grid two">
      <div class="field"><label>Номер ПЛ</label><input name="number" placeholder="например PL-0310" required></div>
      <div class="field"><label>Машина</label><select name="vehicle_id" id="issueVehicle" required><option value="">Выберите машину</option>${options}</select></div>
      <div class="field"><label>Водитель</label><select name="driver_id" id="issueDriver" required><option value="">Выберите водителя</option>${drivers}</select></div>
      <div class="field"><label>Начало</label><input name="valid_from" type="datetime-local" value="${dateTimeLocal()}" required></div>
      <div class="field"><label>Окончание</label><input name="valid_to" type="datetime-local" value="${plusDaysIsoLocal(10)}" required></div>
    </div>
    <details style="margin-top:12px"><summary>Дополнительно</summary><div class="form-grid two">
      <div class="field"><label>Прицеп</label><select name="trailer_id"><option value="">Без прицепа</option>${(x.trailers||[]).map(t=>`<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Цель</label><input name="purpose_text" placeholder="При необходимости"></div>
      <div class="field"><label>Основание</label><input name="authorization_text" placeholder="Распоряжение / основание"></div>
      <div class="field"><label>Груз</label><input name="cargo_name"></div>
      <div class="field"><label>Масса груза, т</label><input name="cargo_mass_t" type="number" step="0.01"></div>
      <div class="field"><label>Группа эксплуатации</label><input name="exploitation_group" value="${esc(x.defaults?.exploitation_group||'строевая')}"></div>
      <div class="field"><label>Старший машины</label><select name="senior_vehicle_employee_id"><option value="">Не указан</option>${(x.employees||[]).map(e=>`<option value="${esc(e.id)}">${esc(e.rank?`${e.rank} `:'')}${esc(e.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Ответственный</label><select name="responsible_employee_id"><option value="">Не указан</option>${(x.employees||[]).map(e=>`<option value="${esc(e.id)}">${esc(e.rank?`${e.rank} `:'')}${esc(e.label)}</option>`).join('')}</select></div>
    </div></details>
    <div id="issueHint" class="demo-note">Пробег, остаток топлива и норма подставятся автоматически.</div>
    <div class="action-row"><button class="primary-btn btn-block" type="submit">Выдать ПЛ</button></div></form>`;
}
function renderCreateVehicle(x) {
  return `${pageHead(x.title||'Добавить технику',x.subtitle||'',true)}
    <form class="form-card" id="vehicleCreateForm"><div class="form-grid two">
      <div class="field"><label>Номер машины</label><input name="internal_number" required></div>
      <div class="field"><label>Тип техники</label><select name="vehicle_class" required>${(x.vehicle_classes||[]).map(v=>`<option value="${esc(v.value)}" data-cat="${esc(v.suggested_category||'')}">${esc(v.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Марка</label><input name="make" required></div>
      <div class="field"><label>Модель</label><input name="model" required></div>
      <div class="field"><label>Гос. / условный номер</label><input name="registration_number"></div>
      <div class="field"><label>Топливо</label><select name="fuel_type_id"><option value="">Не требуется</option>${(x.fuel_types||[]).map(f=>`<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Норма, л/100 км</label><input name="fuel_norm" type="number" step="0.01"></div>
      <div class="field"><label>Категории допуска</label><div class="check-grid">${(x.license_categories||[]).map(c=>`<label class="check-chip"><input type="checkbox" name="required_categories" value="${esc(c)}"><span>${esc(c)}</span></label>`).join('')}</div></div>
    </div>
    <details style="margin-top:12px"><summary>Дополнительно</summary><div class="form-grid two">
      <div class="field"><label>Текущий пробег</label><input name="current_odometer_km" type="number" step="1" value="0"></div>
      <div class="field"><label>Топливо сейчас, л</label><input name="current_fuel_l" type="number" step="0.1"></div>
      <div class="field"><label>Объем бака, л</label><input name="tank_capacity_l" type="number" step="0.1"></div>
      <div class="field"><label>VIN / идентификатор</label><input name="vin"></div>
      <div class="field"><label>Назначение</label><select name="purpose"><option value="general">Общее</option><option value="cargo">Грузовая</option><option value="fuel_tanker">Бензовоз</option><option value="water_tanker">Водовоз</option><option value="utility">Специальное</option></select></div>
    </div></details><div class="action-row"><button class="primary-btn btn-block" type="submit">Добавить технику</button></div></form>`;
}
function renderCreateDriver(x) {
  return `${pageHead(x.title||'Добавить водителя',x.subtitle||'',true)}
    <form class="form-card" id="driverCreateForm"><div class="form-grid two">
      <div class="field"><label>ФИО</label><input name="full_name" required></div>
      <div class="field"><label>Воинское звание</label><input name="rank_title"></div>
      <div class="field"><label>Категории</label><div class="check-grid">${(x.license_categories||[]).map(c=>`<label class="check-chip"><input type="checkbox" name="categories" value="${esc(c)}"><span>${esc(c)}</span></label>`).join('')}</div></div>
      <div class="field"><label>Удостоверение действительно до</label><input name="license_valid_to" type="date"></div>
    </div><details style="margin-top:12px"><summary>Дополнительно</summary><div class="form-grid two">
      <div class="field"><label>Номер удостоверения</label><input name="license_number"></div><div class="field"><label>Телефон</label><input name="phone"></div>
    </div></details><div class="action-row"><button class="primary-btn btn-block" type="submit">Добавить водителя</button></div></form>`;
}
function renderAssignment(x) {
  const selected=x.selected_vehicle;
  const vehicles=(x.vehicles||[]).map(v=>`<option value="${esc(v.id)}">${esc(v.label)}</option>`).join('');
  const drivers=(x.drivers||[]).map(v=>`<option value="${esc(v.id)}">${esc(v.rank?`${v.rank} `:'')}${esc(v.label)} · ${(v.categories||[]).join(', ')}</option>`).join('');
  return `${pageHead(x.title||'Закрепить водителя',x.subtitle||'',true)}
    <form class="form-card" id="assignmentForm"><div class="form-grid">
      <div class="field"><label>Машина</label>${selected?`<input type="hidden" name="vehicle_id" value="${esc(selected.id)}"><input value="${esc(selected.label)}" disabled><div class="hint">Требуется: ${(selected.required_categories||[]).join(', ')||'без ограничений'}</div>`:
      `<select name="vehicle_id" required><option value="">Выберите машину</option>${vehicles}</select>`}</div>
      <div class="field"><label>Водитель</label><select name="driver_id" required><option value="">Выберите водителя</option>${drivers}</select></div>
    </div><div class="action-row"><button class="primary-btn btn-block" type="submit">Закрепить</button></div></form>`;
}
function renderUploadEvidence(x) {
  return `${pageHead('Добавить подтверждение','Фото или PDF до 15 МБ.',true)}
    <form class="form-card" id="evidenceForm"><div class="field"><label>Файл</label><input name="file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required></div>
    <div class="action-row"><button class="primary-btn btn-block" type="submit">Загрузить</button></div></form>`;
}
function renderNewIncident(x) {
  return `${pageHead(x.title||'Новое происшествие',x.subtitle||'',true)}
    <form class="form-card" id="incidentCreateForm"><div class="form-grid">
      <div class="field"><label>Техника</label><select name="vehicle_id" required><option value="">Выберите технику</option>${(x.vehicles||[]).map(v=>`<option value="${esc(v.id)}">${esc(v.label)} · ${esc(v.status_label)}</option>`).join('')}</select></div>
      <div class="field"><label>Когда произошло</label><input name="occurred_at" type="datetime-local" value="${dateTimeLocal()}" required></div>
      <div class="field"><label>Что произошло</label><select name="incident_type" required><option value="">Выберите</option>${(x.incident_types||[]).map(t=>`<option value="${esc(t.value)}">${esc(t.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Кратко опишите</label><textarea name="description" required></textarea></div>
      <div class="field"><label>Место <span class="muted">(необязательно)</span></label><input name="location_name"></div>
    </div><div class="demo-note">Сейчас фиксируем только факт. Состояние техники и решение указываются следующим шагом.</div>
    <div class="action-row"><button class="primary-btn btn-block" type="submit">Зафиксировать происшествие</button></div></form>`;
}
function renderRepairAssessment(x) {
  const a=x.assessment||{};
  return `${pageHead('Результат диагностики',`${x.vehicle?.label||''} №${x.vehicle?.number||''}`,true)}
    <form class="form-card" id="repairAssessmentForm"><div class="form-grid">
      <div class="field"><label>Диагноз</label><textarea name="diagnosis" required>${esc(a.diagnosis||'')}</textarea></div>
      <div class="field"><label>Причина</label><textarea name="root_cause">${esc(a.root_cause||'')}</textarea></div>
      <div class="field"><label>Можно ли было предотвратить?</label><select name="preventability">
        <option value="undetermined">Не определено</option><option value="preventable">Можно было предотвратить</option>
        <option value="partially_preventable">Частично предотвратимо</option><option value="not_reasonably_preventable">Разумно предотвратить нельзя</option>
      </select></div>
      <div class="field"><label>Что сделать, чтобы не повторилось</label><textarea name="preventive_action">${esc(a.preventive_action||'')}</textarea></div>
    </div><div class="action-row"><button class="primary-btn btn-block" type="submit">Сохранить результат</button></div></form>`;
}
function renderMaintenanceComplete(x) {
  const f=x.form||{};
  return `${pageHead('ТО выполнено',`${x.vehicle?.label||''} №${x.vehicle?.number||''}`,true)}
    <form class="form-card" id="maintenanceCompleteForm"><div class="form-grid">
      <div class="field"><label>Пробег</label><input name="odometer_km" type="number" step="1" value="${esc(f.fields?.find(q=>q.id==='odometer_km')?.default ?? x.current?.odometer_km ?? '')}" required></div>
      <div class="field"><label>Дата и время</label><input name="performed_at" type="datetime-local" value="${dateTimeLocal()}" required></div>
      <div class="field"><label>Что сделано</label><textarea name="description">${esc(f.fields?.find(q=>q.id==='description')?.default||x.title||'')}</textarea></div>
      <div class="field"><label>Стоимость <span class="muted">(необязательно)</span></label><input name="cost_amount" type="number" step="0.01"></div>
    </div><div class="action-row"><button class="primary-btn btn-block" type="submit">Сохранить ТО</button></div></form>`;
}

function renderWaybillPrint(pkg) {
  state.currentPrint={type:'waybill',data:pkg};
  const h=pkg.header||{}, rows=pkg.route_rows||[];
  const fuelRows=[
    `<tr><td>${esc(h.fuel_code||'')} / ${esc(h.fuel_name||'')}</td><td>${num(h.opening_fuel_l)}</td><td>${num(h.fuel_received_l)}</td><td>${num(h.closing_fuel_l)}</td><td>${num(h.normative_consumption_l)}</td><td>${num(h.actual_consumption_l)}</td><td>${h.variance_l>0?num(h.variance_l):''}</td><td>${h.variance_l<0?num(Math.abs(h.variance_l)):''}</td></tr>`,
    `<tr><td>Масло</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`
  ].join('');
  const routeData=rows.map((r,idx)=>`<tr>
    <td class="left">${esc(r.route_text||'')}</td><td>${dt(r.departed_at)}</td><td>${dt(r.arrived_at)}</td>
    <td>${num(r.automobile_total_km,0)}</td><td>${num(r.automobile_with_cargo_km,0)}</td><td>${num(r.automobile_with_towed_equipment_km,0)}</td>
    <td>${num(r.distance_afloat_or_towed_km,0)}</td><td>${num(r.trailer_mileage_total_km,0)}</td><td>${num(r.trailer_mileage_with_cargo_km,0)}</td>
    <td class="left">${esc(r.cargo_name||'')}</td><td>${num(r.cargo_total_t)}</td><td>${num(r.cargo_on_trailer_t)}</td>
    <td>${num(r.transport_work_tkm)}</td><td>${num(r.engine_hours_total)}</td><td>${num(r.engine_hours_stationary)}</td>
    <td class="left">${esc([
      r.print_opening_odometer_km!=null?`${num(r.print_opening_odometer_km,0)} км`:'',
      r.print_opening_time?onlyTime(r.print_opening_time):'',
      r.print_opening_place||'',
      r.print_closing_odometer_km!=null?`${num(r.print_closing_odometer_km,0)} км`:'',
      r.print_closing_time?onlyTime(r.print_closing_time):'',
      r.print_closing_place||''
    ].filter(Boolean).join(' / '))}</td></tr>`).join('');
  const blank=Array.from({length:Math.max(0,12-rows.length)},()=>`<tr>${Array.from({length:16},()=>'<td>&nbsp;</td>').join('')}</tr>`).join('');
  const print = `<div class="print-toolbar no-print">${button('Печать / сохранить PDF','browser-print',{kind:'primary'})}${button('Назад','back',{kind:'soft'})}</div>
  <div class="print-stage" id="printStage">
    <section class="paper">
      <div class="paper-title">ПУТЕВОЙ ЛИСТ № ${esc(h.number||'')}</div><div class="paper-sub">от ${d(h.valid_from)}</div>
      <div class="print-fields">
        ${pf('Наименование организации',h.organization_name)}${pf('Водитель',`${h.driver_rank||''} ${h.driver_full_name||''}`)}
        ${pf('Путевой лист действителен по',d(h.valid_to))}${pf('Старший машины',`${h.senior_vehicle_rank||''} ${h.senior_vehicle_full_name||''}`)}
        ${pf('Маршрут движения / основание',h.authorization_text)}${pf('Ответственный за эксплуатацию ТС',`${h.responsible_rank||''} ${h.responsible_full_name||''}`)}
        ${pf('Для каких целей назначается',h.purpose_text)}${pf('Место / подразделение',h.organization_location)}
      </div>
      <table class="print-table clearance-table"><tr><th>Предрейсовый медицинский осмотр пройден</th><th>Машина технически исправна</th><th>Техническое состояние машины проверил</th><th>Дежурный по парку</th></tr>
        <tr><td>дата ________ время ________<br><br>подпись __________</td><td>дата ________ время ________<br><br>подпись __________</td><td>перед выездом ________<br>после возвращения ________<br>подпись __________</td><td>Убытие / Прибытие<br>по плану ________ / ________<br>фактически ${dt(h.actual_departure_at)} / ${dt(h.actual_return_at)}<br>одометр ${num(h.actual_opening_odometer_km,0)} / ${num(h.actual_closing_odometer_km,0)}</td></tr>
      </table>
      <table class="print-table" style="margin-top:3mm"><tr><th>Для каких целей</th><th>Тип, марка и модель</th><th>Гос. / условный номер</th><th>Прицеп</th><th>Номер прицепа</th><th>Группа эксплуатации</th><th>Груз</th><th>Масса, т</th></tr>
      <tr><td>${esc(h.purpose_text||'')}</td><td>${esc(`${h.vehicle_make||''} ${h.vehicle_model||''}`)}</td><td>${esc(h.vehicle_registration_number||h.vehicle_internal_number||'')}</td><td>${esc(`${h.trailer_make||''} ${h.trailer_model||''}`)}</td><td>${esc(h.trailer_registration_number||'')}</td><td>${esc(h.exploitation_group||'')}</td><td>${esc(h.cargo_name||'')}</td><td>${num(h.cargo_mass_t)}</td></tr></table>
      <div class="paper-title" style="font-size:10px;margin-top:3mm">1. Расход горючего и смазочных материалов (в литрах)</div>
      <table class="print-table"><tr><th>Наименование</th><th>Наличие перед выездом</th><th>Получено</th><th>Наличие при постановке</th><th>Положено по норме</th><th>Фактически</th><th>Сверх нормы</th><th>Экономия</th></tr>${fuelRows}</table>
    </section>
    <section class="paper">
      <div class="paper-title" style="font-size:12px">2. Работа машины</div>
      <table class="print-table waybill-route"><thead>
      <tr><th rowspan="3" style="width:19%">Маршрут движения<br>(откуда, куда)</th><th colspan="2">Дата, время</th><th colspan="6">Пройдено километров</th><th colspan="3">Перевезено</th><th rowspan="3">т·км</th><th colspan="2">Моточасы</th><th rowspan="3" style="width:11%">Показания одометра, время и место отпуска машины</th></tr>
      <tr><th rowspan="2">убытия</th><th rowspan="2">прибытия</th><th colspan="4">автомобилем</th><th colspan="2">прицепом</th><th rowspan="2">груз</th><th colspan="2">количество, т</th><th rowspan="2">всего</th><th rowspan="2">на месте</th></tr>
      <tr><th>всего</th><th>с грузом</th><th>с букс. ВВТ</th><th>на плаву / буксире</th><th>всего</th><th>с грузом</th><th>всего</th><th>на прицепе</th></tr>
      <tr>${Array.from({length:16},(_,i)=>`<th>${i+1}</th>`).join('')}</tr></thead><tbody>${routeData}${blank}</tbody></table>
      <div style="margin-top:7mm;font-size:9px">Сведения о работе машины и маршрутах движения подтверждаю: водитель ____________________________</div>
      <div style="margin-top:4mm;font-size:9px">Правильность оформления путевого листа проверил ____________________________</div>
    </section>
  </div>`;
  return `${pageHead(`ПЛ ${h.number||''}`,pkg.print_mode==='final'?'Готов к итоговой печати':'Рабочая печатная форма',true)}${print}`;
}
function pf(label,value){return `<div class="print-field"><span class="label">${esc(label)}</span><span class="value">${esc(value||'')}</span></div>`;}

function renderStatementPrint(pkg) {
  state.currentPrint={type:'statement',data:pkg};
  const pages=(pkg.pages||[]).map(p=>statementPage(pkg,p)).join('');
  return `${pageHead('Сводная ведомость',pkg.period?.label||'',true)}
    ${!pkg.ready_for_print?`<div class="alert warning no-print"><div>△</div><div><div class="alert-title">Период еще не готов к итоговой печати</div><div class="alert-sub">Блокирующих вопросов: ${num(pkg.blocking_issues_count,0)}. Предпросмотр показывает только подтвержденные данные.</div></div></div>`:''}
    <div class="print-toolbar no-print">${button(pkg.ready_for_print?'Печать / сохранить PDF':'Печать предварительного варианта','browser-print',{kind:'primary'})}</div>
    <div class="print-stage" id="printStage">${pages}</div>`;
}
function statementPage(pkg,p) {
  const blocks=(p.blocks||[]).map((b,idx)=>statementBlock(b,idx+1)).join('');
  const totals=p.is_last_page?periodTotals(pkg.period_totals||[]):'';
  return `<section class="paper statement-paper">
    <div class="statement-title">Сводная ведомость расхода горючего в подразделении за период ${esc(pkg.period?.label||'')}</div>
    <table class="print-table statement-table"><thead>
      <tr><th rowspan="3">№</th><th rowspan="3">Марка, модель</th><th rowspan="3">Гос./условный №</th>
      <th colspan="6">Путевой лист № 1</th><th colspan="6">Путевой лист № 2</th><th colspan="6">Путевой лист № 3</th><th rowspan="3">Горючее</th></tr>
      <tr>${Array.from({length:3},()=>'<th>ост. выезд</th><th>пробег выезд</th><th>получено</th><th>пробег возврат</th><th>израсход.</th><th>ост. возврат</th>').join('')}</tr>
      <tr>${Array.from({length:18},(_,i)=>`<th>${i+1}</th>`).join('')}</tr>
    </thead><tbody>${blocks}</tbody></table>
    ${statementSlotTotals(p.slot_totals||[])}
    ${totals}
    <div style="font-size:6px;text-align:right;margin-top:2mm">Страница ${num(p.page_no,0)} из ${num(pkg.stats?.page_count,0)}</div>
  </section>`;
}
function statementBlock(b,n) {
  const seg=[1,2,3].map(slot=>(b.segments||[]).find(s=>Number(s.slot)===slot)||null);
  const top=`<tr><td rowspan="2">${n}</td><td rowspan="2">${esc(`${b.make} ${b.model}`)}</td><td rowspan="2">${esc(b.registration_number||b.internal_number)}</td>
    ${seg.map(s=>`<td colspan="3">${s?`ПЛ ${esc(s.waybill_number)}`:''}</td><td colspan="3">${s?d(s.issued_at):''}</td>`).join('')}<td rowspan="2">${esc(b.fuel_display||'')}</td></tr>`;
  const data=`<tr class="vehicle-data">${seg.map(s=>s?`<td>${num(s.opening_fuel_l)}</td><td>${num(s.opening_odometer_km,0)}</td><td>${num(s.fuel_received_l)}</td><td>${num(s.closing_odometer_km,0)}</td><td>${num(s.actual_consumption_l)}</td><td>${num(s.closing_fuel_l)}</td>`:'<td></td>'.repeat(6)).join('')}</tr>`;
  return top+data;
}
function statementSlotTotals(totals) {
  if (!totals.length) return '';
  const fuels=[...new Set(totals.map(t=>t.fuel_display))];
  return `<table class="print-table statement-table" style="margin-top:2mm"><tbody>${fuels.map(f=>{
    const arr=[1,2,3].map(s=>totals.find(t=>t.fuel_display===f&&Number(t.print_slot_no)===s));
    return `<tr class="statement-total ${f?.includes('АИ')?'ai':''}"><td style="width:26%">${esc(f)} — итоги по странице</td>${arr.map(t=>`<td>нач. ${num(t?.opening_fuel_l)} · получ. ${num(t?.fuel_received_l)} · расход ${num(t?.actual_consumption_l)} · кон. ${num(t?.closing_fuel_l)}</td>`).join('')}</tr>`;
  }).join('')}</tbody></table>`;
}
function periodTotals(totals) {
  if (!totals.length) return '';
  return `<div class="period-total-grid"><div><strong>Горючее</strong></div><div><strong>Остаток на начало</strong></div><div><strong>Всего получено</strong></div><div><strong>Всего израсходовано</strong></div><div><strong>Остаток на конец</strong></div>
    ${totals.map(t=>`<div><strong>${esc(t.fuel_display)}</strong></div><div>${num(t.opening_fuel_l)}</div><div>${num(t.fuel_received_l)}</div><div>${num(t.actual_consumption_l)}</div><div>${num(t.closing_fuel_l)}</div>`).join('')}</div>`;
}

async function actionHandler(el) {
  const a=el.dataset.action;
  if (!a) return;
  if (a==='logout') return logout();
  if (a==='refresh') return navigate(state.view,state.params,{replace:true});
  if (a==='back') return goBack();
  if (a==='main-nav') {
    const id=el.dataset.id;
    if (state.shell.role==='admin') return navigate(id==='home'?'home':id,{}, {reset:true,replace:true});
    return navigate(id==='history'?'driverHistory':'driverWork',{}, {reset:true,replace:true});
  }
  if (a==='attention') {
    const id=el.dataset.id;
    if (id==='incidents') return navigate('incidents');
    if (id==='waybills_review') return navigate('reviewQueue');
    return navigate('service');
  }
  if (a==='open-review-queue') return navigate('reviewQueue');
  if (a==='issue-waybill') return navigate('issueWaybill',{vehicle:el.dataset.vehicle||''});
  if (a==='add-vehicle') return navigate('createVehicle');
  if (a==='add-driver') return navigate('createDriver');
  if (a==='open-drivers') return navigate('drivers');
  if (a==='open-incidents') return navigate('incidents');
  if (a==='open-vehicle') return navigate('vehicle',{id:el.dataset.id});
  if (a==='open-driver') return navigate('driver',{id:el.dataset.id});
  if (a==='open-repair') return navigate('repair',{id:el.dataset.id});
  if (a==='open-maintenance') return navigate('maintenance',{id:el.dataset.id});
  if (a==='open-incident') return navigate('incident',{id:el.dataset.id});
  if (a==='open-package') return navigate('package',{id:el.dataset.id,incidentId:el.dataset.incident});
  if (a==='print-waybill' || a==='vehicle-print') {
    const id=el.dataset.id||el.dataset.waybill; if (!id) return;
    return navigate('waybillPrint',{id});
  }
  if (a==='print-statement') return navigate('statementPrint',{id:el.dataset.id});
  if (a==='open-waybill-review') return navigate('waybillReview',{id:el.dataset.id});
  if (a==='assignment') return navigate('assignment',{vehicleId:el.dataset.vehicle});
  if (a==='service-item') {
    if (el.dataset.type==='repair') return navigate('repair',{id:el.dataset.id});
    if (el.dataset.type==='maintenance') return navigate('maintenance',{id:el.dataset.id});
    return;
  }
  if (a==='driver-action') { const da=el.dataset.driverAction; if(da==='correction'){toast('Замечание администратора будет показано отдельной карточкой.','');return;} return navigate('driverAction',{action:da,waybillId:el.dataset.waybill}); }
  if (a==='browser-print') return window.print();
  if (a==='prepare-package') {
    el.disabled=true;
    try { await rpc('prepare_document_package',{p_package_id:el.dataset.id}); toast('Пакет подготовлен','success'); await navigate('package',state.params,{replace:true}); }
    catch(e){toast(errorText(e),'error');} finally{el.disabled=false;} return;
  }
  if (a==='set-incident-condition') {
    if (!confirm(`Зафиксировать состояние: «${el.textContent.trim()}»?`)) return;
    el.disabled=true;
    try { await rpc('set_incident_vehicle_condition',{p_incident_id:el.dataset.id,p_outcome:el.dataset.value,p_note:null}); toast('Состояние сохранено','success'); await navigate('incident',{id:el.dataset.id},{replace:true}); }
    catch(e){toast(errorText(e),'error');} finally{el.disabled=false;} return;
  }
  if (a==='upload-evidence') return navigate('uploadEvidence',{incidentId:el.dataset.incident,packageId:el.dataset.package});
  if (a==='begin-review') {
    try { await rpc('begin_waybill_review',{p_waybill_id:el.dataset.id}); toast('ПЛ взят на проверку','success'); await navigate('waybillReview',{id:el.dataset.id},{replace:true}); } catch(e){toast(errorText(e),'error');} return;
  }
  if (a==='approve-waybill') {
    if (!confirm('Утвердить путевой лист? После утверждения конечные пробег и топливо станут подтвержденным состоянием машины.')) return;
    try { await rpc('approve_waybill',{p_waybill_id:el.dataset.id}); toast('Путевой лист утвержден','success'); await navigate('waybillReview',{id:el.dataset.id},{replace:true}); } catch(e){toast(errorText(e),'error');} return;
  }
  if (a==='return-correction') {
    const type=prompt('Что проверить? Введите: closing_state, route, refuel или other','other'); if (!type) return;
    const msg=prompt('Короткое замечание водителю','Проверьте данные и отправьте повторно.'); if (!msg) return;
    try { await rpc('return_waybill_for_correction',{p_waybill_id:el.dataset.id,p_correction_type:type,p_message:msg}); toast('ПЛ возвращен водителю','success'); await navigate('waybillReview',{id:el.dataset.id},{replace:true}); } catch(e){toast(errorText(e),'error');} return;
  }
  if (a==='repair-action') {
    const act=el.dataset.action;
    const repairAction=el.dataset.actionName||el.dataset.repairAction||el.getAttribute('data-action-name')||el.dataset.actionid;
    const requested=el.dataset.repairAction || el.getAttribute('data-repair-action') || el.dataset.step || '';
    const actual=requested || el.dataset.actionValue || '';
    if(actual==='edit_assessment') return navigate('repairAssessment',{id:el.dataset.id});
    const value=actual || (el.textContent.includes('Начать ремонт')?'start_repair':el.textContent.includes('Нужны запчасти')?'wait_parts':el.textContent.includes('На проверку')?'start_testing':el.textContent.includes('Вернуть в строй')?'return_to_service':'');
    if(!value){toast('Действие не распознано.','error');return;}
    if(!confirm(`Выполнить: «${el.textContent.trim()}»?`)) return;
    try{await rpc('advance_repair_case',{p_case_id:el.dataset.id,p_action:value});toast('Этап ремонта обновлен','success');await navigate('repair',{id:el.dataset.id},{replace:true});}catch(e){toast(errorText(e),'error');}
    return;
  }
  if (a==='complete-maintenance') return navigate('maintenanceComplete',{id:el.dataset.id});
  if (a==='new-incident') return navigate('newIncident');
}

document.addEventListener('click', e=>{
  const el=e.target.closest('[data-action]');
  if (!el) return;
  actionHandler(el);
});

document.addEventListener('submit', async e=>{
  const form=e.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id==='driverActionForm') {
    e.preventDefault();
    const btn=form.querySelector('button[type=submit]'); btn.disabled=true;
    const fd=new FormData(form), x=state.currentActionForm, p=state.params, command=x.submit?.command;
    const value=k=>{const v=fd.get(k); return v===''?null:v;};
    const uuid=crypto.randomUUID();
    try {
      if (command==='start_waybill') await rpc('start_waybill',{p_waybill_id:p.waybillId,p_odometer_km:Number(value('odometer_km')),p_location_name:value('location_name'),p_occurred_at:new Date().toISOString(),p_client_action_id:uuid});
      else if (command==='record_departure') await rpc('record_waybill_event',{p_waybill_id:p.waybillId,p_event_type:'departure',p_odometer_km:Number(value('odometer_km')),p_location_name:value('location_name'),p_occurred_at:new Date().toISOString(),p_client_action_id:uuid});
      else if (command==='record_arrival') await rpc('record_waybill_event',{p_waybill_id:p.waybillId,p_event_type:'arrival',p_odometer_km:Number(value('odometer_km')),p_location_name:value('location_name'),p_occurred_at:new Date().toISOString(),p_client_action_id:uuid});
      else if (command==='record_refuel') await rpc('record_refuel',{p_waybill_id:p.waybillId,p_quantity_l:Number(value('quantity_l')),p_odometer_km:Number(value('odometer_km')),p_occurred_at:new Date().toISOString(),p_client_action_id:uuid});
      else if (command==='record_park') await rpc('record_waybill_event',{p_waybill_id:p.waybillId,p_event_type:'parked',p_odometer_km:Number(value('odometer_km')),p_location_name:value('location_name'),p_occurred_at:new Date().toISOString(),p_client_action_id:uuid});
      else if (command==='close_waybill') await rpc('close_waybill',{p_waybill_id:p.waybillId,p_closing_odometer_km:Number(value('closing_odometer_km')||value('odometer_km')),p_closing_fuel_l:Number(value('closing_fuel_l')),p_occurred_at:new Date().toISOString(),p_client_action_id:uuid});
      else if (command==='report_defect') await rpc('report_defect',{p_waybill_id:p.waybillId,p_odometer_km:Number(x.hidden_defaults?.odometer_km||0),p_category:value('category'),p_description:value('description'),p_severity:Number(value('severity')),p_occurred_at:new Date().toISOString(),p_client_action_id:uuid});
      else throw new Error('Неизвестная команда');
      toast('Сохранено','success'); state.stack=[]; await navigate('driverWork',{}, {replace:true,reset:true});
    } catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;}
    return;
  }
  if (form.id==='issueForm') {
    e.preventDefault(); const btn=form.querySelector('button[type=submit]');btn.disabled=true; const fd=new FormData(form); const v=k=>fd.get(k)||null;
    try {
      const id=await rpc('issue_waybill_v2',{
        p_number:v('number'),p_vehicle_id:v('vehicle_id'),p_driver_id:v('driver_id'),
        p_valid_from:new Date(v('valid_from')).toISOString(),p_valid_to:new Date(v('valid_to')).toISOString(),
        p_trailer_id:v('trailer_id'),p_authorization_text:v('authorization_text'),p_purpose_text:v('purpose_text'),
        p_exploitation_group:v('exploitation_group'),p_cargo_name:v('cargo_name'),
        p_cargo_mass_t:v('cargo_mass_t')?Number(v('cargo_mass_t')):null,
        p_senior_vehicle_employee_id:v('senior_vehicle_employee_id'),p_responsible_employee_id:v('responsible_employee_id')
      });
      toast('Путевой лист выдан','success'); state.stack=[]; await navigate('waybillReview',{id},{replace:true,reset:false});
    } catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;} return;
  }
  if (form.id==='vehicleCreateForm') {
    e.preventDefault();const btn=form.querySelector('button[type=submit]');btn.disabled=true;const fd=new FormData(form);const val=k=>fd.get(k)||null;
    try {
      const cls=val('vehicle_class'), isTrailer=cls==='trailer';
      const id=await rpc('create_vehicle_simple',{
        p_internal_number:val('internal_number'),p_make:val('make'),p_model:val('model'),p_vehicle_class:cls,
        p_registration_number:val('registration_number'),p_fuel_type_id:isTrailer?null:val('fuel_type_id'),
        p_fuel_norm:isTrailer?null:(val('fuel_norm')?Number(val('fuel_norm')):null),
        p_required_categories:fd.getAll('required_categories'),
        p_current_odometer_km:Number(val('current_odometer_km')||0),
        p_current_fuel_l:isTrailer?null:(val('current_fuel_l')?Number(val('current_fuel_l')):null),
        p_tank_capacity_l:isTrailer?null:(val('tank_capacity_l')?Number(val('tank_capacity_l')):null),
        p_vin:val('vin'),p_purpose:val('purpose')||'general'
      });
      toast('Техника добавлена','success');state.stack=[];await navigate('vehicle',{id},{replace:true});
    } catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;} return;
  }
  if (form.id==='driverCreateForm') {
    e.preventDefault();const btn=form.querySelector('button[type=submit]');btn.disabled=true;const fd=new FormData(form);const val=k=>fd.get(k)||null;
    try {
      const id=await rpc('create_driver_simple',{p_full_name:val('full_name'),p_categories:fd.getAll('categories'),p_rank_title:val('rank_title'),p_license_valid_to:val('license_valid_to'),p_license_number:val('license_number'),p_phone:val('phone')});
      toast('Водитель добавлен','success');state.stack=[];await navigate('driver',{id},{replace:true});
    } catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;} return;
  }
  if (form.id==='assignmentForm') {
    e.preventDefault();const btn=form.querySelector('button[type=submit]');btn.disabled=true;const fd=new FormData(form);
    try { await rpc('assign_driver_vehicle',{p_vehicle_id:fd.get('vehicle_id'),p_driver_id:fd.get('driver_id')}); toast('Водитель закреплен','success'); await goBack(); }
    catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;} return;
  }
  if (form.id==='incidentCreateForm') {
    e.preventDefault(); const btn=form.querySelector('button[type=submit]'); btn.disabled=true; const fd=new FormData(form);
    try {
      const id=await rpc('create_incident_fact',{
        p_vehicle_id:fd.get('vehicle_id'),p_occurred_at:new Date(fd.get('occurred_at')).toISOString(),
        p_incident_type:fd.get('incident_type'),p_description:fd.get('description'),
        p_location_name:fd.get('location_name')||null,p_waybill_id:null
      });
      toast('Происшествие зафиксировано','success'); state.stack=[]; await navigate('incident',{id},{replace:true});
    } catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;} return;
  }
  if (form.id==='repairAssessmentForm') {
    e.preventDefault(); const btn=form.querySelector('button[type=submit]'); btn.disabled=true; const fd=new FormData(form);
    try {
      await rpc('save_repair_assessment',{
        p_case_id:state.params.id,p_diagnosis:fd.get('diagnosis')||null,p_root_cause:fd.get('root_cause')||null,
        p_preventability:fd.get('preventability')||'undetermined',p_preventive_action:fd.get('preventive_action')||null
      });
      toast('Результат диагностики сохранен','success'); await navigate('repair',{id:state.params.id},{replace:true});
    } catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;} return;
  }
  if (form.id==='maintenanceCompleteForm') {
    e.preventDefault(); const btn=form.querySelector('button[type=submit]'); btn.disabled=true; const fd=new FormData(form);
    if(!confirm('Записать выполненное ТО? Это изменит историю обслуживания тестовой машины.')){btn.disabled=false;return;}
    try {
      await rpc('complete_maintenance',{
        p_rule_id:state.params.id,p_odometer_km:Number(fd.get('odometer_km')),
        p_performed_at:new Date(fd.get('performed_at')).toISOString(),p_description:fd.get('description')||null,
        p_cost_amount:fd.get('cost_amount')?Number(fd.get('cost_amount')):null
      });
      toast('ТО записано','success'); await navigate('maintenance',{id:state.params.id},{replace:true});
    } catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;} return;
  }
  if (form.id==='evidenceForm') {
    e.preventDefault();const btn=form.querySelector('button[type=submit]');btn.disabled=true;const fd=new FormData(form);const file=fd.get('file');
    try { if (!(file instanceof File) || !file.size) throw new Error('Выберите файл'); if(file.size>15*1024*1024) throw new Error('Файл больше 15 МБ'); await uploadIncidentEvidence(state.params.incidentId,file);toast('Подтверждение загружено','success'); await navigate('incident',{id:state.params.incidentId},{replace:true});}
    catch(err){toast(errorText(err),'error');} finally{btn.disabled=false;} return;
  }
});

document.addEventListener('change', async e=>{
  if (e.target?.id==='issueVehicle') {
    const vehicleId=e.target.value; if(!vehicleId)return;
    try {
      const ctx=await rpc('get_waybill_issue_context',{p_vehicle_id:vehicleId});
      const sel=document.getElementById('issueDriver');
      if(sel){
        sel.innerHTML='<option value="">Выберите водителя</option>'+ctx.drivers.map(d=>`<option value="${esc(d.id)}" ${d.recommended?'selected':''}>${esc(d.rank?`${d.rank} `:'')}${esc(d.label)}</option>`).join('');
      }
      const hint=document.getElementById('issueHint');
      if(hint) hint.textContent=`Старт: ${num(ctx.defaults?.opening_odometer_km,0)} км, ${num(ctx.defaults?.opening_fuel_l)} л. Срок по умолчанию: ${num(ctx.defaults?.duration_days,0)} дней.`;
    } catch(err){toast(errorText(err),'error');}
  }
});

(async function init(){
  if (!state.session) return renderLogin();
  try { await bootstrap(); }
  catch { renderLogin(); }
})();
