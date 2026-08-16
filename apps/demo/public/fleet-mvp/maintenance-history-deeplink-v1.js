const MHD_VERSION='2026.08.16-maint-history-deeplink1';
const MHD_PENDING='fleet_mvp_pending_maintenance_event';
function mhdTryOpen(){const id=sessionStorage.getItem(MHD_PENDING);if(!id)return;const button=[...document.querySelectorAll('[data-mhe-edit]')].find(x=>x.dataset.mheEdit===id);if(!button)return;sessionStorage.removeItem(MHD_PENDING);button.dataset.mhdOpened=MHD_VERSION;queueMicrotask(()=>button.click())}
let mhdQueued=false;function mhdSchedule(){if(mhdQueued)return;mhdQueued=true;queueMicrotask(()=>{mhdQueued=false;mhdTryOpen()})}
new MutationObserver(mhdSchedule).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('fleet:role-ux-ready',mhdSchedule);mhdSchedule();
