const PROD_HARDENING_VERSION='2026.08.17-prod4';
const LEGACY_DEMO_URL='https://tikjmiyrhkcjrxjylmqb.supabase.co';
const LEGACY_DEMO_KEY='sb_publishable_clr5P9USk7b63MajJmmr9A_Iz0wi_0F';
const runtime=window.__FLEET_PROD_CONFIG__||{};
const PROD_CFG={url:String(runtime.supabaseUrl||'').replace(/\/$/,''),key:String(runtime.publishableKey||'')};
const PROD_SESSION_KEY='fleet_mvp_session_v2';
const PROD_BACKEND_KEY='fleet_prod_backend_v1';
const PROD_DEFAULT_TIMEZONE='Europe/Moscow';
const NativeDateTimeFormat=Intl.DateTimeFormat;
const NativeFetch=globalThis.fetch.bind(globalThis);
let prodTimezone=PROD_DEFAULT_TIMEZONE;
let timezoneLoaded=false;

function prodBackendId(){try{return new URL(PROD_CFG.url).hostname.split('.')[0]}catch{return''}}
function prodSession(){try{return JSON.parse(localStorage.getItem(PROD_SESSION_KEY)||'null')}catch{return null}}
function prodResetCrossBackendState(){
  const current=prodBackendId();const previous=localStorage.getItem(PROD_BACKEND_KEY);
  if(previous&&previous!==current){
    for(const key of [PROD_SESSION_KEY,'fleet_mvp_offline_queue_v1','fleet_mvp_driver_action_cache_v1','fleet_mvp_offline_owner_v1','fleet_mvp_offline_user_vault_v1'])localStorage.removeItem(key);
    sessionStorage.removeItem('fleet_mvp_driver_action_ctx');
  }
  localStorage.setItem(PROD_BACKEND_KEY,current);
}
prodResetCrossBackendState();

globalThis.fetch=async function fleetProdFetch(input,init){
  const originalUrl=typeof input==='string'||input instanceof URL?String(input):input?.url;
  if(!originalUrl||!originalUrl.startsWith(LEGACY_DEMO_URL))return NativeFetch(input,init);
  const target=`${PROD_CFG.url}${originalUrl.slice(LEGACY_DEMO_URL.length)}`;
  const baseHeaders=input instanceof Request?input.headers:undefined;
  const headers=new Headers(baseHeaders||{});
  if(init?.headers)new Headers(init.headers).forEach((v,k)=>headers.set(k,v));
  headers.set('apikey',PROD_CFG.key);
  if(input instanceof Request){const request=new Request(target,input);return NativeFetch(request,{...init,headers})}
  return NativeFetch(target,{...(init||{}),headers});
};

function prodParts(date,tz=prodTimezone){const p=new NativeDateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);return Object.fromEntries(p.map(i=>[i.type,i.value]))}
function prodLocalString(date,tz=prodTimezone){const p=prodParts(date,tz);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`}
function prodDeviceLocalString(date){const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`}
function prodZonedLocalToDate(value,tz=prodTimezone){
  const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);if(!m)return null;
  const naive=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));let guess=naive;
  for(let i=0;i<3;i++){const p=prodParts(new Date(guess),tz);const represented=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);guess=naive-(represented-guess)}
  const result=new Date(guess);return Number.isNaN(result.getTime())?null:result;
}
function FleetDateTimeFormat(locales,options){const o={...(options||{})};if(!o.timeZone)o.timeZone=prodTimezone;return new NativeDateTimeFormat(locales,o)}
Object.setPrototypeOf(FleetDateTimeFormat,NativeDateTimeFormat);
FleetDateTimeFormat.prototype=NativeDateTimeFormat.prototype;
FleetDateTimeFormat.supportedLocalesOf=NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat);
Intl.DateTimeFormat=FleetDateTimeFormat;

async function prodLoadTimezone(){
  const s=prodSession();if(!s?.access_token)return false;
  try{
    const r=await NativeFetch(`${PROD_CFG.url}/rest/v1/rpc/current_fleet_timezone`,{method:'POST',headers:{apikey:PROD_CFG.key,Authorization:`Bearer ${s.access_token}`,'Content-Type':'application/json'},body:'{}'});
    if(!r.ok)return false;const t=await r.text();const v=t?JSON.parse(t):null;
    if(typeof v==='string'&&v){prodTimezone=v;timezoneLoaded=true;prodNormalizeDateInputs(document);return true}
  }catch(err){console.warn('Fleet timezone fallback is active',err)}
  return false;
}
function prodNormalizeDateInput(input){
  if(!(input instanceof HTMLInputElement)||input.type!=='datetime-local'||input.dataset.prodTz==='1'||!input.value)return;
  const deviceInstant=new Date(input.value);if(!Number.isNaN(deviceInstant.getTime()))input.value=prodLocalString(deviceInstant);input.dataset.prodTz='1';
}
function prodNormalizeDateInputs(root){root.querySelectorAll?.('input[type="datetime-local"]').forEach(prodNormalizeDateInput)}
function setTextIfChanged(el,value){if(el&&el.textContent!==value)el.textContent=value}
function prodScrubDemoUi(root=document){
  const email=root.matches?.('#email')?root:root.querySelector?.('#email');if(email&&email.value==='fleet.admin@example.com')email.value='';
  const loginSubs=[];if(root.matches?.('.login-sub'))loginSubs.push(root);root.querySelectorAll?.('.login-sub').forEach(el=>loginSubs.push(el));loginSubs.forEach(el=>setTextIfChanged(el,'Защищённый рабочий контур'));
  const demoNotes=[];if(root.matches?.('.demo-note'))demoNotes.push(root);root.querySelectorAll?.('.demo-note').forEach(el=>demoNotes.push(el));demoNotes.forEach(el=>{if(!el.hidden)el.hidden=true;if(el.getAttribute('aria-hidden')!=='true')el.setAttribute('aria-hidden','true')});
  const brandSubs=[];if(root.matches?.('.brand-sub'))brandSubs.push(root);root.querySelectorAll?.('.brand-sub').forEach(el=>brandSubs.push(el));brandSubs.forEach(el=>{const next=el.textContent.replace(/\s*·\s*MVP\s*·\s*синтетические данные/gi,' · рабочий контур').replace(/синтетические данные/gi,'рабочий контур');setTextIfChanged(el,next)});
  if(document.title!=='АСУ Автопарк')document.title='АСУ Автопарк';
}
new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes){if(!(n instanceof Element))continue;if(n.matches?.('input[type="datetime-local"]'))prodNormalizeDateInput(n);prodNormalizeDateInputs(n);prodScrubDemoUi(n)}}).observe(document.documentElement,{childList:true,subtree:true});

document.addEventListener('submit',e=>{
  const form=e.target;if(!(form instanceof HTMLFormElement))return;const changed=[];
  form.querySelectorAll('input[type="datetime-local"]').forEach(input=>{if(!input.value)return;const original=input.value;const instant=prodZonedLocalToDate(original);if(!instant)return;input.value=prodDeviceLocalString(instant);changed.push([input,original])});
  if(changed.length)queueMicrotask(()=>changed.forEach(([input,original])=>{if(input.isConnected)input.value=original}));
},true);

async function prodPurgeLocalSensitiveState(){
  for(const key of ['fleet_mvp_offline_queue_v1','fleet_mvp_driver_action_cache_v1','fleet_mvp_offline_owner_v1','fleet_mvp_offline_user_vault_v1'])localStorage.removeItem(key);
  sessionStorage.removeItem('fleet_mvp_driver_action_ctx');
  if('caches' in globalThis){try{const names=await caches.keys();await Promise.all(names.filter(n=>/fleet/i.test(n)).map(n=>caches.delete(n)))}catch(err){console.warn('Fleet cache cleanup failed',err)}}
}
async function prodLogout(){
  const s=prodSession();
  try{if(s?.access_token)await NativeFetch(`${PROD_CFG.url}/auth/v1/logout?scope=local`,{method:'POST',headers:{apikey:PROD_CFG.key,Authorization:`Bearer ${s.access_token}`}})}catch(err){console.warn('Server logout was not confirmed; local session will still be removed',err)}
  try{await prodPurgeLocalSensitiveState()}finally{localStorage.removeItem(PROD_SESSION_KEY);window.dispatchEvent(new CustomEvent('fleet:logout-complete',{detail:{version:PROD_HARDENING_VERSION}}));location.reload()}
}
document.addEventListener('click',e=>{const button=e.target.closest?.('[data-action="logout"]');if(!button)return;e.preventDefault();e.stopImmediatePropagation();button.disabled=true;prodLogout()},true);

prodNormalizeDateInputs(document);prodScrubDemoUi(document);prodLoadTimezone();
const timezonePoll=setInterval(async()=>{if(await prodLoadTimezone())clearInterval(timezonePoll)},3000);setTimeout(()=>clearInterval(timezonePoll),30000);
window.addEventListener('focus',()=>{if(!timezoneLoaded)prodLoadTimezone()});
window.PROD_HARDENING={version:PROD_HARDENING_VERSION,backend:prodBackendId(),get timezone(){return prodTimezone},reloadTimezone:prodLoadTimezone};
