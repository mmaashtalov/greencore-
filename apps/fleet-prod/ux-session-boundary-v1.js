const UXSB_VERSION='2026.08.17-session3';
const KEYS={session:'fleet_mvp_session_v2',queue:'fleet_mvp_offline_queue_v1',forms:'fleet_mvp_driver_action_cache_v1',ctx:'fleet_mvp_driver_action_ctx',owner:'fleet_mvp_offline_owner_v1',vault:'fleet_mvp_offline_user_vault_v1'};
let logoutReloadScheduled=false,lastRole=document.body.dataset.role||'';
function json(storage,key,fallback){try{return JSON.parse(storage.getItem(key)||'null')??fallback}catch{return fallback}}
function userId(){const s=json(localStorage,KEYS.session,null);return s?.user?.id||s?.user?.sub||s?.user?.email||null}
function vault(){return json(localStorage,KEYS.vault,{})}
function saveVault(v){localStorage.setItem(KEYS.vault,JSON.stringify(v))}
function hasWorkingState(){return localStorage.getItem(KEYS.queue)!==null||localStorage.getItem(KEYS.forms)!==null}
function stash(owner){if(!owner||!hasWorkingState())return;const v=vault();v[owner]={saved_at:Date.now(),queue:json(localStorage,KEYS.queue,[]),forms:json(localStorage,KEYS.forms,{})};saveVault(v);localStorage.removeItem(KEYS.queue);localStorage.removeItem(KEYS.forms)}
function restore(uid){if(!uid)return;const currentOwner=localStorage.getItem(KEYS.owner);if(currentOwner&&currentOwner!==uid)stash(currentOwner);const v=vault();if(!hasWorkingState()&&v[uid]){localStorage.setItem(KEYS.queue,JSON.stringify(v[uid].queue||[]));localStorage.setItem(KEYS.forms,JSON.stringify(v[uid].forms||{}))}localStorage.setItem(KEYS.owner,uid);sessionStorage.removeItem(KEYS.ctx)}
function scheduleReload(){if(logoutReloadScheduled)return;logoutReloadScheduled=true;setTimeout(()=>location.reload(),40)}
function isolateForRole(){const role=document.body.dataset.role,uid=userId();if(role==='guest'&&['driver','admin'].includes(lastRole)){const owner=localStorage.getItem(KEYS.owner);if(owner)stash(owner);localStorage.removeItem(KEYS.owner);sessionStorage.removeItem(KEYS.ctx);lastRole=role;scheduleReload();return}lastRole=role||lastRole;if(role==='driver'&&uid){restore(uid);return}if(role==='admin'){const owner=localStorage.getItem(KEYS.owner);if(owner)stash(owner);localStorage.removeItem(KEYS.owner);sessionStorage.removeItem(KEYS.ctx)}}
function purgeSensitiveState(){localStorage.removeItem(KEYS.queue);localStorage.removeItem(KEYS.forms);localStorage.removeItem(KEYS.owner);localStorage.removeItem(KEYS.vault);sessionStorage.removeItem(KEYS.ctx)}
function beforeLogout(){purgeSensitiveState()}
document.addEventListener('click',e=>{if(e.target.closest('[data-action="logout"]'))beforeLogout()},true);
window.addEventListener('fleet:ui-ready',isolateForRole);
queueMicrotask(isolateForRole);
