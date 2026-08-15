const UXI_VERSION='2026.08.16-inbox2';
const UXI_CFG={
  url:'https://tikjmiyrhkcjrxjylmqb.supabase.co',
  key:'sb_publishable_clr5P9USk7b63MajJmmr9A_Iz0wi_0F',
  sessionKey:'fleet_mvp_session_v2'
};
let uxiOverlay=null;
let uxiReturnFocus=null;
let uxiBusy=false;
let uxiTimer=null;

function uxiSession(){
  try{return JSON.parse(localStorage.getItem(UXI_CFG.sessionKey)||'null')}catch{return null}
}
function uxiSaveSession(session){
  if(session)localStorage.setItem(UXI_CFG.sessionKey,JSON.stringify(session));
}
async function uxiRefreshSession(){
  const session=uxiSession();
  if(!session?.refresh_token)throw new Error('Сессия истекла. Войдите снова.');
  const response=await fetch(`${UXI_CFG.url}/auth/v1/token?grant_type=refresh_token`,{
    method:'POST',
    headers:{apikey:UXI_CFG.key,'Content-Type':'application/json'},
    body:JSON.stringify({refresh_token:session.refresh_token})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data.access_token)throw new Error(data.message||data.msg||'Сессия истекла. Войдите снова.');
  data.obtained_at=Date.now();
  uxiSaveSession(data);
  return data;
}
async function uxiFetch(path,options={},retry=true){
  let session=uxiSession();
  if(!session?.access_token)throw new Error('Нужно войти в систему.');
  const headers=new Headers(options.headers||{});
  headers.set('apikey',UXI_CFG.key);
  headers.set('Authorization',`Bearer ${session.access_token}`);
  if(options.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  let response=await fetch(`${UXI_CFG.url}${path}`,{...options,headers});
  if(response.status===401&&retry){
    session=await uxiRefreshSession();
    headers.set('Authorization',`Bearer ${session.access_token}`);
    response=await fetch(`${UXI_CFG.url}${path}`,{...options,headers});
  }
  if(!response.ok){
    const error=await response.json().catch(()=>({}));
    throw new Error(error.message||error.error||`HTTP ${response.status}`);
  }
  return response;
}
function uxiRole(){return document.body.dataset.role||''}
function uxiAdminFilter(){return uxiRole()==='admin'?'&employee_id=is.null':''}
function uxiEsc(value=''){
  return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
}
function uxiDate(value){
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '';
  return new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
}
function uxiBellSvg(){
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
function uxiEnsureButton(){
  if(!['admin','driver'].includes(uxiRole())||!uxiSession())return;
  const host=document.querySelector('.topbar-actions');
  if(!host||host.querySelector('[data-uxi-open]'))return;
  const button=document.createElement('button');
  button.type='button';
  button.className='icon-btn uxi-bell';
  button.dataset.uxiOpen='1';
  button.title='Уведомления';
  button.setAttribute('aria-label','Открыть уведомления');
  button.innerHTML=`${uxiBellSvg()}<span class="uxi-badge" hidden></span>`;
  host.prepend(button);
}
function uxiSetBadge(count){
  uxiEnsureButton();
  const badge=document.querySelector('[data-uxi-open] .uxi-badge');
  const button=document.querySelector('[data-uxi-open]');
  if(!badge||!button)return;
  const n=Math.max(0,Number(count)||0);
  badge.hidden=n===0;
  badge.textContent=n>99?'99+':String(n);
  button.setAttribute('aria-label',n?`Уведомления: непрочитанных ${n}`:'Уведомления: новых нет');
}
async function uxiUnreadCount(){
  if(!uxiSession()||!['admin','driver'].includes(uxiRole()))return 0;
  const response=await uxiFetch(`/rest/v1/notifications?select=id&is_read=eq.false${uxiAdminFilter()}&limit=1`,{
    headers:{Prefer:'count=exact'}
  });
  const range=response.headers.get('content-range')||'';
  const total=Number(range.split('/')[1]);
  if(Number.isFinite(total))return total;
  const rows=await response.json().catch(()=>[]);
  return rows.length;
}
async function uxiLoadItems(){
  const response=await uxiFetch(`/rest/v1/notifications?select=id,title,body,notification_type,is_read,created_at,vehicle_id&order=created_at.desc${uxiAdminFilter()}&limit=30`);
  return response.json();
}
function uxiToast(text,type=''){
  let host=document.querySelector('.toast-host');
  if(!host){host=document.createElement('div');host.className='toast-host';document.body.appendChild(host)}
  const node=document.createElement('div');node.className=`toast ${type}`;node.textContent=text;host.appendChild(node);setTimeout(()=>node.remove(),3600);
}
function uxiEmpty(){
  return '<div class="uxi-empty"><div class="uxi-empty-mark">✓</div><strong>Новых сообщений нет</strong><span>Здесь появятся замечания, предупреждения и системные сообщения.</span></div>';
}
function uxiTarget(item){
  const role=uxiRole();
  if(role==='driver'&&item.notification_type==='waybill_correction')return {id:'driver_correction',label:'Исправить сейчас'};
  if(role==='admin'&&item.notification_type==='waybill_correction_submitted')return {id:'review_queue',label:'Открыть проверку'};
  if(role==='admin'&&item.notification_type==='maintenance_due')return {id:'service',label:'Открыть ТО'};
  if(role==='admin'&&item.notification_type==='repair')return {id:'service',label:'Открыть ремонт'};
  if(role==='admin'&&item.notification_type==='incident')return {id:'incidents',label:'Открыть происшествия'};
  return null;
}
function uxiItem(item){
  const unread=!item.is_read;
  const target=uxiTarget(item);
  return `<article class="uxi-item ${unread?'unread':''}" data-uxi-id="${uxiEsc(item.id)}">
    <div class="uxi-dot" aria-hidden="true"></div>
    <div class="uxi-copy">
      <div class="uxi-item-head"><strong>${uxiEsc(item.title||'Уведомление')}</strong><time>${uxiEsc(uxiDate(item.created_at))}</time></div>
      <p>${uxiEsc(item.body||'')}</p>
      ${(target||unread)?`<div class="uxi-actions">${target?`<button type="button" class="uxi-go" data-uxi-go="${uxiEsc(target.id)}" data-uxi-notification="${uxiEsc(item.id)}">${uxiEsc(target.label)}</button>`:''}${unread?`<button type="button" class="uxi-read" data-uxi-read="${uxiEsc(item.id)}">Прочитано</button>`:''}</div>`:''}
    </div>
  </article>`;
}
function uxiRender(items,count){
  if(!uxiOverlay)return;
  const list=uxiOverlay.querySelector('.uxi-list');
  const countNode=uxiOverlay.querySelector('[data-uxi-count]');
  if(countNode)countNode.textContent=count?`${count} непрочитанных`:'Новых нет';
  if(list)list.innerHTML=items.length?items.map(uxiItem).join(''):uxiEmpty();
}
async function uxiReload(){
  if(uxiBusy)return;
  uxiBusy=true;
  const refresh=uxiOverlay?.querySelector('[data-uxi-refresh]');
  refresh?.classList.add('spinning');
  try{
    const [items,count]=await Promise.all([uxiLoadItems(),uxiUnreadCount()]);
    uxiSetBadge(count);
    uxiRender(items,count);
  }catch(error){
    if(uxiOverlay){
      const list=uxiOverlay.querySelector('.uxi-list');
      if(list)list.innerHTML=`<div class="uxi-error"><strong>Не удалось загрузить уведомления</strong><span>${uxiEsc(error.message||'Ошибка соединения')}</span><button type="button" class="soft-btn" data-uxi-retry>Повторить</button></div>`;
    }
  }finally{
    refresh?.classList.remove('spinning');
    uxiBusy=false;
  }
}
function uxiClose(){
  if(!uxiOverlay)return;
  uxiOverlay.remove();
  uxiOverlay=null;
  document.body.classList.remove('uxi-open');
  if(uxiReturnFocus?.isConnected)uxiReturnFocus.focus();
  uxiReturnFocus=null;
}
function uxiOpen(){
  if(uxiOverlay)return;
  uxiReturnFocus=document.activeElement;
  const overlay=document.createElement('div');
  overlay.className='uxi-backdrop';
  overlay.innerHTML=`<section class="uxi-sheet" role="dialog" aria-modal="true" aria-labelledby="uxiTitle">
    <header class="uxi-head"><div><span class="uxi-kicker">Центр сообщений</span><h2 id="uxiTitle">Уведомления</h2><small data-uxi-count>Загрузка…</small></div><div class="uxi-head-actions"><button type="button" class="uxi-icon-btn" data-uxi-refresh aria-label="Обновить уведомления" title="Обновить">↻</button><button type="button" class="uxi-icon-btn" data-uxi-close aria-label="Закрыть">×</button></div></header>
    <div class="uxi-list" aria-live="polite"><div class="inline-loading"><div class="spinner"></div><span>Загрузка…</span></div></div>
  </section>`;
  document.body.appendChild(overlay);
  document.body.classList.add('uxi-open');
  uxiOverlay=overlay;
  overlay.querySelector('[data-uxi-close]')?.focus();
  uxiReload();
}
async function uxiPatchRead(id){
  if(!id)return;
  await uxiFetch(`/rest/v1/notifications?id=eq.${encodeURIComponent(id)}`,{
    method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({is_read:true})
  });
}
async function uxiMarkRead(id,button){
  if(!id||button?.disabled)return;
  if(button)button.disabled=true;
  try{
    await uxiPatchRead(id);
    const item=uxiOverlay?.querySelector(`[data-uxi-id="${CSS.escape(id)}"]`);
    item?.classList.remove('unread');
    button?.remove();
    const count=await uxiUnreadCount();
    uxiSetBadge(count);
    const countNode=uxiOverlay?.querySelector('[data-uxi-count]');
    if(countNode)countNode.textContent=count?`${count} непрочитанных`:'Новых нет';
  }catch(error){
    if(button)button.disabled=false;
    uxiToast(error.message||'Не удалось отметить сообщение','error');
  }
}
function uxiDispatchAction(action,data={}){
  const node=document.createElement('button');
  node.type='button';
  node.hidden=true;
  node.dataset.action=action;
  for(const [key,value] of Object.entries(data))node.dataset[key]=value;
  document.body.appendChild(node);
  node.click();
  queueMicrotask(()=>node.remove());
}
function uxiNavigate(target){
  if(target==='driver_correction')return uxiDispatchAction('driver-action',{driverAction:'open_corrections'});
  if(target==='review_queue')return uxiDispatchAction('open-review-queue');
  if(target==='service')return uxiDispatchAction('main-nav',{id:'service'});
  if(target==='incidents')return uxiDispatchAction('open-incidents');
}
async function uxiGo(target,id,button){
  if(button?.disabled)return;
  if(button)button.disabled=true;
  try{await uxiPatchRead(id)}catch{}
  uxiSetBadge(Math.max(0,Number(document.querySelector('[data-uxi-open] .uxi-badge')?.textContent||1)-1));
  uxiClose();
  queueMicrotask(()=>uxiNavigate(target));
}
async function uxiRefreshBadge(){
  if(!uxiSession()||!['admin','driver'].includes(uxiRole())){uxiSetBadge(0);return}
  try{uxiSetBadge(await uxiUnreadCount())}catch{}
}
function uxiStartTimer(){
  if(uxiTimer)return;
  uxiTimer=setInterval(()=>{if(document.visibilityState==='visible')uxiRefreshBadge()},60000);
}

document.addEventListener('click',event=>{
  if(event.target.closest('[data-uxi-open]')){event.preventDefault();uxiOpen();return}
  if(event.target.closest('[data-uxi-close]')){event.preventDefault();uxiClose();return}
  if(event.target===uxiOverlay){uxiClose();return}
  if(event.target.closest('[data-uxi-refresh],[data-uxi-retry]')){event.preventDefault();uxiReload();return}
  const go=event.target.closest('[data-uxi-go]');
  if(go){event.preventDefault();uxiGo(go.dataset.uxiGo,go.dataset.uxiNotification,go);return}
  const read=event.target.closest('[data-uxi-read]');
  if(read){event.preventDefault();uxiMarkRead(read.dataset.uxiRead,read)}
},true);
document.addEventListener('keydown',event=>{
  if(!uxiOverlay)return;
  if(event.key==='Escape'){event.preventDefault();uxiClose();return}
  if(event.key!=='Tab')return;
  const focusable=[...uxiOverlay.querySelectorAll('button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(el=>el.offsetParent!==null);
  if(!focusable.length)return;
  const first=focusable[0],last=focusable[focusable.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
});
window.addEventListener('fleet:ui-ready',()=>{uxiEnsureButton();uxiRefreshBadge();uxiStartTimer()});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')uxiRefreshBadge()});
queueMicrotask(()=>{uxiEnsureButton();uxiRefreshBadge();uxiStartTimer()});
