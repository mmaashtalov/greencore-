const PATCH_CFG = {
  url: 'https://tikjmiyrhkcjrxjylmqb.supabase.co',
  key: 'sb_publishable_clr5P9USk7b63MajJmmr9A_Iz0wi_0F',
  version: '2026.08.15-ui4'
};
const PATCH_SESSION_KEY = 'fleet_mvp_session_v2';

function patchSession() {
  try { return JSON.parse(localStorage.getItem(PATCH_SESSION_KEY) || 'null'); } catch { return null; }
}
function savePatchSession(session) {
  if (session) localStorage.setItem(PATCH_SESSION_KEY, JSON.stringify(session));
}
async function refreshPatchSession() {
  const session = patchSession();
  if (!session?.refresh_token) throw new Error('Сессия истекла. Войдите снова.');
  const res = await fetch(`${PATCH_CFG.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {apikey: PATCH_CFG.key, 'Content-Type':'application/json'},
    body: JSON.stringify({refresh_token: session.refresh_token})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.message || data.msg || 'Сессия истекла. Войдите снова.');
  data.obtained_at = Date.now();
  savePatchSession(data);
  return data;
}
async function patchRpc(name, params={}, retry=true) {
  let session = patchSession();
  if (!session?.access_token) throw new Error('Нужно войти в систему.');
  let res = await fetch(`${PATCH_CFG.url}/rest/v1/rpc/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {apikey: PATCH_CFG.key,Authorization: `Bearer ${session.access_token}`,'Content-Type': 'application/json'},
    body: JSON.stringify(params)
  });
  if (res.status === 401 && retry) {
    session = await refreshPatchSession();
    res = await fetch(`${PATCH_CFG.url}/rest/v1/rpc/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {apikey: PATCH_CFG.key,Authorization: `Bearer ${session.access_token}`,'Content-Type': 'application/json'},
      body: JSON.stringify(params)
    });
  }
  if (!res.ok) {
    const x = await res.json().catch(() => ({}));
    throw new Error(x.message || x.error || `HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
function patchToast(text, type='') {
  let host = document.querySelector('.toast-host');
  if (!host) {host = document.createElement('div');host.className = 'toast-host';document.body.appendChild(host);}
  const el = document.createElement('div');el.className = `toast ${type}`;el.textContent = text;host.appendChild(el);setTimeout(() => el.remove(), 3600);
}
function shortDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}).format(d);
}
function compactHeader() {
  const sub = document.querySelector('.brand-sub');
  if (!sub || sub.dataset.uiPatch === PATCH_CFG.version) return;
  const role = /Водитель/i.test(sub.textContent || '') ? 'Водитель' : 'Администратор';
  sub.textContent = `Демо · ${role}`;sub.dataset.uiPatch = PATCH_CFG.version;
}
function roleCandidates(employees, type) {
  const all = employees || [];const nonDrivers = all.filter(e => !/водитель/i.test(e.position || ''));
  if (type === 'senior') {const exact = all.filter(e => /старш.*машин/i.test(e.position || ''));return exact.length ? exact : nonDrivers;}
  const exact = all.filter(e => /ответствен.*эксплуатац|ответствен.*техник|начальник.*авто/i.test(e.position || ''));return exact.length ? exact : nonDrivers;
}
function fillEmployeeSelect(select, candidates, emptyLabel) {
  if (!select) return;const current = select.value;
  select.innerHTML = `<option value="">${emptyLabel}</option>` + candidates.map(e => `<option value="${e.id}">${[e.rank,e.label,e.position].filter(Boolean).join(' · ')}</option>`).join('');
  if (candidates.some(e => e.id === current)) select.value = current;else if (candidates.length === 1) select.value = candidates[0].id;
}
function makeCompactPeriod(form) {
  const from = form.elements.valid_from;const to = form.elements.valid_to;if (!from || !to || form.querySelector('.issue-period')) return;
  const fromField = from.closest('.field');const toField = to.closest('.field');const grid = fromField?.parentElement;if (!fromField || !toField || !grid) return;
  const details = document.createElement('details');details.className = 'issue-period';const summary = document.createElement('summary');const inner = document.createElement('div');inner.className = 'form-grid two issue-period-grid';details.append(summary, inner);inner.append(fromField, toField);grid.append(details);
  const update = () => { summary.textContent = `Срок: ${shortDateTime(from.value)} — ${shortDateTime(to.value)}`; };from.addEventListener('change', update);to.addEventListener('change', update);update();
}
async function hydrateIssueForm(form) {
  if (!form || form.dataset.uiPatch) return;form.dataset.uiPatch = PATCH_CFG.version;
  const vehicle = form.elements.vehicle_id;const driver = form.elements.driver_id;const trailer = form.elements.trailer_id;const submit = form.querySelector('button[type="submit"]');const hint = document.getElementById('issueHint');if (!vehicle || !driver) return;
  vehicle.id = 'issueVehicleV2';driver.id = 'issueDriverV2';makeCompactPeriod(form);
  try {const issueData = await patchRpc('get_waybill_issue_form');fillEmployeeSelect(form.elements.senior_vehicle_employee_id, roleCandidates(issueData?.employees, 'senior'), 'Не указан');fillEmployeeSelect(form.elements.responsible_employee_id, roleCandidates(issueData?.employees, 'responsible'), 'Не указан');} catch (_) {}
  let seq = 0;
  async function refreshCompatibility() {
    const token = ++seq;const vehicleId = vehicle.value;const trailerId = trailer?.value || null;const previousDriver = driver.value;
    if (!vehicleId) {driver.innerHTML = '<option value="">Сначала выберите машину</option>';driver.disabled = true;if (submit) submit.disabled = true;if (hint) hint.textContent = 'Выберите машину — система сама покажет подходящих водителей.';return null;}
    driver.disabled = true;if (submit) submit.disabled = true;if (hint) hint.textContent = 'Проверяем допуск водителя…';
    try {
      const ctx = await patchRpc('get_waybill_issue_context_v2', {p_vehicle_id: vehicleId, p_trailer_id: trailerId});if (token !== seq) return null;const drivers = ctx?.drivers || [];
      driver.innerHTML = '<option value="">Выберите водителя</option>' + drivers.map(d => `<option value="${d.id}">${[d.rank,d.label].filter(Boolean).join(' ')} · ${(d.categories || []).join(',')}</option>`).join('');
      if (drivers.some(d => d.id === previousDriver)) driver.value = previousDriver;else if (ctx?.recommended_driver_id && drivers.some(d => d.id === ctx.recommended_driver_id)) driver.value = ctx.recommended_driver_id;else if (drivers.length === 1) driver.value = drivers[0].id;
      driver.disabled = drivers.length === 0;if (submit) submit.disabled = drivers.length === 0;
      const req = [...(ctx?.vehicle?.required_categories || []), ...(ctx?.trailer?.required_categories || [])];
      if (hint) {hint.textContent = drivers.length ? `Старт: ${Math.round(Number(ctx?.defaults?.opening_odometer_km || 0)).toLocaleString('ru-RU')} км · ${Number(ctx?.defaults?.opening_fuel_l ?? 0).toLocaleString('ru-RU')} л${req.length ? ` · допуск ${[...new Set(req)].join(' + ')}` : ''}.` : `Нет свободного водителя с требуемым допуском${req.length ? ` (${[...new Set(req)].join(' + ')})` : ''}.`;hint.classList.toggle('compat-danger', drivers.length === 0);}
      return ctx;
    } catch (e) {if (token !== seq) return null;driver.innerHTML = '<option value="">Не удалось проверить допуск</option>';driver.disabled = true;if (submit) submit.disabled = true;if (hint) hint.textContent = e.message || 'Не удалось проверить допуск.';patchToast(e.message || 'Не удалось проверить допуск.', 'error');return null;}
  }
  vehicle.addEventListener('change', refreshCompatibility);trailer?.addEventListener('change', refreshCompatibility);
  form.addEventListener('submit', async e => {
    if (form.dataset.compatValidated === '1') {form.dataset.compatValidated = '';return;}
    e.preventDefault();e.stopImmediatePropagation();
    const vehicleId = vehicle.value;const driverId = driver.value;
    if (!vehicleId || !driverId) {patchToast(!vehicleId ? 'Сначала выберите машину.' : 'Выберите подходящего водителя.', 'error');return;}
    if (submit) submit.disabled = true;
    try {
      const ctx = await patchRpc('get_waybill_issue_context_v2', {p_vehicle_id: vehicleId, p_trailer_id: trailer?.value || null});const valid = (ctx?.drivers || []).some(d => d.id === driverId);
      if (!valid) {patchToast('Водитель больше не доступен для этой машины. Список обновлён.', 'error');await refreshCompatibility();return;}
      form.dataset.compatValidated = '1';form.requestSubmit();
    } catch (err) {patchToast(err.message || 'Не удалось проверить допуск.', 'error');}
    finally {if (form.dataset.compatValidated !== '1' && submit) submit.disabled = false;}
  }, true);
  await refreshCompatibility();
}
let scheduled = false;
function scanUi() {scheduled = false;compactHeader();const issueForm = document.getElementById('issueForm');if (issueForm) hydrateIssueForm(issueForm);}
function scheduleScan() {if (scheduled) return;scheduled = true;queueMicrotask(scanUi);}
new MutationObserver(scheduleScan).observe(document.documentElement, {childList:true, subtree:true});scheduleScan();
