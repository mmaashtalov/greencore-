const PROD_HARDENING_VERSION='2026.08.17-prod2';
const PROD_CFG={url:'https://tikjmiyrhkcjrxjylmqb.supabase.co',key:'sb_publishable_clr5P9USk7b63MajJmmr9A_Iz0wi_0F'};
const PROD_SESSION_KEY='fleet_mvp_session_v2';
const PROD_DEFAULT_TIMEZONE='Europe/Moscow';
const NativeDateTimeFormat=Intl.DateTimeFormat;
let prodTimezone=PROD_DEFAULT_TIMEZONE;
let timezoneLoaded=false;

function prodSession(){try{return JSON.parse(localStorage.getItem(PROD_SESSION_KEY)||'null')}catch{return null}}
function prodParts(date,tz=prodTimezone){const p=new NativeDateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);return Object.fromEntries(p.map(i=>[i.type,i.value]))}
function prodLocalString(date,tz=prodTimezone){const p=prodParts(date,tz);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`}
function prodDeviceLocalString(date){const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`}
function prodZonedLocalToDate(value,tz=prodTimezone){
  const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if(!m)return null;
  const naive=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0));
  let guess=naive;
  for(let i=0;i<3;i++){
    const p=prodParts(new Date(guess),tz);
    const represented=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
    guess=naive-(represented-guess);
  }
  const result=new Date(guess);
  return Number.isNaN(result.getTime())?null:result;
}

// Force application-wide date rendering through the organization timezone unless a caller explicitly requests another timezone.
function FleetDateTimeFormat(locales,options){const o={...(options||{})};if(!o.timeZone)o.timeZone=prodTimezone;return new NativeDateTimeFormat(locales,o)}
Object.setPrototypeOf(FleetDateTimeFormat,NativeDateTimeFormat);
FleetDateTimeFormat.prototype=NativeDateTimeFormat.prototype;
FleetDateTimeFormat.supportedLocalesOf=NativeDateTimeFormat.supportedLocalesOf.bind(NativeDateTimeFormat);
Intl.DateTimeFormat=FleetDateTimeFormat;

async function prodLoadTimezone(){
  const s=prodSession();
  if(!s?.access_token)return false;
  try{
    const r=await fetch(`${PROD_CFG.url}/rest/v1/rpc/current_fleet_timezone`,{method:'POST',headers:{apikey:PROD_CFG.key,Authorization:`Bearer ${s.access_token}`,'Content-Type':'application/json'},body:'{}'});
    if(!r.ok)return false;
    const t=await r.text();const v=t?JSON.parse(t):null;
    if(typeof v==='string'&&v){prodTimezone=v;timezoneLoaded=true;prodNormalizeDateInputs(document);return true}
  }catch(err){console.warn('Fleet timezone fallback is active',err)}
  return false;
}

// Existing modules create datetime-local values in the device timezone. Normalize those values to the fleet timezone exactly once per rendered control.
function prodNormalizeDateInput(input){
  if(!(input instanceof HTMLInputElement)||input.type!=='datetime-local'||input.dataset.prodTz==='1'||!input.value)return;
  const deviceInstant=new Date(input.value);
  if(!Number.isNaN(deviceInstant.getTime()))input.value=prodLocalString(deviceInstant);
  input.dataset.prodTz='1';
}
function prodNormalizeDateInputs(root){root.querySelectorAll?.('input[type="datetime-local"]').forEach(prodNormalizeDateInput)}
new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes){if(!(n instanceof Element))continue;if(n.matches?.('input[type="datetime-local"]'))prodNormalizeDateInput(n);prodNormalizeDateInputs(n)}}).observe(document.documentElement,{childList:true,subtree:true});

// Before legacy handlers parse datetime-local with new Date(value), temporarily translate fleet-local wall time into the device-local representation of the same instant.
document.addEventListener('submit',e=>{
  const form=e.target;if(!(form instanceof HTMLFormElement))return;
  const changed=[];
  form.querySelectorAll('input[type="datetime-local"]').forEach(input=>{
    if(!input.value)return;const original=input.value;const instant=prodZonedLocalToDate(original);if(!instant)return;
    input.value=prodDeviceLocalString(instant);changed.push([input,original]);
  });
  if(changed.length)queueMicrotask(()=>changed.forEach(([input,original])=>{if(input.isConnected)input.value=original}));
},true);

async function prodPurgeLocalSensitiveState(){
  for(const key of ['fleet_mvp_offline_queue_v1','fleet_mvp_driver_action_cache_v1','fleet_mvp_offline_owner_v1','fleet_mvp_offline_user_vault_v1'])localStorage.removeItem(key);
  sessionStorage.removeItem('fleet_mvp_driver_action_ctx');
  if('caches' in globalThis){try{const names=await caches.keys();await Promise.all(names.filter(n=>/fleet/i.test(n)).map(n=>caches.delete(n)))}catch(err){console.warn('Fleet cache cleanup failed',err)}}
}
async function prodLogout(){
  const s=prodSession();
  try{if(s?.access_token)await fetch(`${PROD_CFG.url}/auth/v1/logout?scope=local`,{method:'POST',headers:{apikey:PROD_CFG.key,Authorization:`Bearer ${s.access_token}`}})}catch(err){console.warn('Server logout was not confirmed; local session will still be removed',err)}
  try{await prodPurgeLocalSensitiveState()}finally{localStorage.removeItem(PROD_SESSION_KEY);window.dispatchEvent(new CustomEvent('fleet:logout-complete',{detail:{version:PROD_HARDENING_VERSION}}));location.reload()}
}

// This listener is registered before application modules and owns explicit logout end-to-end.
document.addEventListener('click',e=>{
  const button=e.target.closest?.('[data-action="logout"]');if(!button)return;
  e.preventDefault();e.stopImmediatePropagation();button.disabled=true;prodLogout();
},true);

prodNormalizeDateInputs(document);
prodLoadTimezone();
const timezonePoll=setInterval(async()=>{if(await prodLoadTimezone())clearInterval(timezonePoll)},3000);
setTimeout(()=>clearInterval(timezonePoll),30000);
window.addEventListener('focus',()=>{if(!timezoneLoaded)prodLoadTimezone()});
window.PROD_HARDENING={version:PROD_HARDENING_VERSION,get timezone(){return prodTimezone},reloadTimezone:prodLoadTimezone};
