const PROD_HARDENING_VERSION='2026.08.17-prod1';
const PROD_SESSION_KEY='fleet_mvp_session_v2';
const PROD_DEFAULT_TIMEZONE='Europe/Moscow';
let prodTimezone=PROD_DEFAULT_TIMEZONE;

function prodSession(){try{return JSON.parse(localStorage.getItem(PROD_SESSION_KEY)||'null')}catch{return null}}
function prodFmt(v,options={}){if(!v)return'';const x=new Date(v);if(Number.isNaN(x.getTime()))return'';return new Intl.DateTimeFormat('ru-RU',{...options,timeZone:prodTimezone}).format(x)}
function prodParts(v){const x=v?new Date(v):new Date();const p=new Intl.DateTimeFormat('en-CA',{timeZone:prodTimezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(x);return Object.fromEntries(p.map(i=>[i.type,i.value]))}
function prodDateTimeLocal(v){const p=prodParts(v);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`}
function prodAddDaysLocal(days){return prodDateTimeLocal(new Date(Date.now()+Number(days||0)*86400000))}
async function prodLoadTimezone(){const s=prodSession();if(!s?.access_token)return;try{const r=await fetch(`${CFG.url}/rest/v1/rpc/current_fleet_timezone`,{method:'POST',headers:{apikey:CFG.key,Authorization:`Bearer ${s.access_token}`,'Content-Type':'application/json'},body:'{}'});if(!r.ok)return;const t=await r.text();const v=t?JSON.parse(t):null;if(typeof v==='string'&&v)prodTimezone=v}catch(err){console.warn('Fleet timezone fallback is active',err)}}

// One application timezone for all browser-side rendering and datetime-local defaults.
if(typeof globalThis.d==='function')globalThis.d=v=>{if(!v)return'—';return prodFmt(v,{day:'2-digit',month:'2-digit',year:'numeric'})||esc(v)};
if(typeof globalThis.dt==='function')globalThis.dt=v=>{if(!v)return'—';return prodFmt(v,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})||esc(v)};
if(typeof globalThis.onlyTime==='function')globalThis.onlyTime=v=>prodFmt(v,{hour:'2-digit',minute:'2-digit'});
if(typeof globalThis.dateTimeLocal==='function')globalThis.dateTimeLocal=prodDateTimeLocal;
if(typeof globalThis.plusDaysIsoLocal==='function')globalThis.plusDaysIsoLocal=prodAddDaysLocal;
if(typeof globalThis.wpd==='function')globalThis.wpd=v=>prodFmt(v,{day:'2-digit',month:'2-digit',year:'numeric'});
if(typeof globalThis.wpdt==='function')globalThis.wpdt=v=>prodFmt(v,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
if(typeof globalThis.wpt==='function')globalThis.wpt=v=>prodFmt(v,{hour:'2-digit',minute:'2-digit'});

// Canonical DB clearance values. Legacy UI names are accepted only at the rendering boundary.
if(typeof globalThis.clearance==='function')globalThis.clearance=(pkg,type)=>{const aliases={medical_pretrip:['medical_pre'],medical:['medical_pre'],medical_pre:['medical_pre'],medical_post:['medical_post'],technical_pretrip:['technical_pre'],technical:['technical_pre'],technical_pre:['technical_pre'],technical_posttrip:['technical_post'],technical_post:['technical_post']};const accepted=aliases[String(type)]||[String(type)];return (pkg?.clearances||[]).find(x=>accepted.includes(String(x.clearance_type)))||null};

async function prodSha256(file){if(!globalThis.crypto?.subtle)throw new Error('Браузер не поддерживает контроль целостности SHA-256.');const buf=await file.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',buf);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')}

// Upload evidence atomically from the user's perspective: hash -> object -> metadata; orphan object is deleted on metadata failure.
if(typeof globalThis.uploadIncidentEvidence==='function')globalThis.uploadIncidentEvidence=async function(incidentId,file){
  const safe=file.name.replace(/[^a-zA-Z0-9А-Яа-я._-]+/g,'_').slice(-80)||'evidence';
  const path=`${incidentId}/${crypto.randomUUID()}-${safe}`;
  const objectPath=`/storage/v1/object/incident-evidence/${path.split('/').map(encodeURIComponent).join('/')}`;
  const sha256=await prodSha256(file);
  let uploaded=false;
  try{
    await globalThis.api(objectPath,{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','x-upsert':'false'},body:file});
    uploaded=true;
    await globalThis.rpc('register_incident_evidence',{p_incident_id:incidentId,p_evidence_type:file.type==='application/pdf'?'pdf':'photo',p_storage_path:path,p_description:null,p_sha256:sha256});
    return path;
  }catch(err){
    if(uploaded){try{await globalThis.api(objectPath,{method:'DELETE'})}catch(cleanupErr){console.error('Evidence orphan cleanup failed',path,cleanupErr)}}
    throw err;
  }
};

async function prodPurgeLocalSensitiveState(){
  for(const key of ['fleet_mvp_offline_queue_v1','fleet_mvp_driver_action_cache_v1','fleet_mvp_offline_owner_v1','fleet_mvp_offline_user_vault_v1'])localStorage.removeItem(key);
  sessionStorage.removeItem('fleet_mvp_driver_action_ctx');
  if('caches' in globalThis){try{const names=await caches.keys();await Promise.all(names.filter(n=>/fleet/i.test(n)).map(n=>caches.delete(n)))}catch(err){console.warn('Fleet cache cleanup failed',err)}}
}

// Server-side local-session revoke first; local state is always removed even when the network is unavailable.
if(typeof globalThis.logout==='function')globalThis.logout=async function(){
  const s=prodSession();
  try{
    if(s?.access_token){await fetch(`${CFG.url}/auth/v1/logout?scope=local`,{method:'POST',headers:{apikey:CFG.key,Authorization:`Bearer ${s.access_token}`}})}
  }catch(err){console.warn('Server logout was not confirmed; local session will still be removed',err)}
  try{await prodPurgeLocalSensitiveState()}finally{localStorage.removeItem(PROD_SESSION_KEY);window.dispatchEvent(new CustomEvent('fleet:logout-complete',{detail:{version:PROD_HARDENING_VERSION}}));setTimeout(()=>location.reload(),60)}
};

prodLoadTimezone();
window.addEventListener('fleet:ui-ready',prodLoadTimezone);
window.PROD_HARDENING_VERSION=PROD_HARDENING_VERSION;
