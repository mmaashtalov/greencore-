const UXRL_VERSION='2026.08.15-role1';
const loaded=new Set();
const modules={
  admin:[
    './ux-waybills-list-v2.js?v=20260815-1',
    './ux-waybill-insight-v1.js?v=20260815-1',
    './ux-vehicle-primary-v1.js?v=20260815-1',
    './ux-breadcrumb-v1.js?v=20260815-1',
    './ux-filter-v1.js?v=20260815-1',
    './ux-responsibility-v1.js?v=20260815-1',
    './ux-global-search-v1.js?v=20260815-1'
  ],
  driver:[
    './ux-driver-state-v1.js?v=20260815-1',
    './ux-driver-form-v1.js?v=20260815-1'
  ]
};
async function loadRole(role){
  if(!modules[role]||loaded.has(role))return;
  loaded.add(role);
  const started=performance.now();
  for(const src of modules[role]){
    try{await import(src)}catch(err){console.warn('Role UX module failed',src,err)}
  }
  window.dispatchEvent(new CustomEvent('fleet:role-ux-ready',{detail:{role,version:UXRL_VERSION,duration_ms:Math.round(performance.now()-started)}}));
}
window.addEventListener('fleet:ui-ready',e=>loadRole(e.detail?.role||document.body.dataset.role));
queueMicrotask(()=>loadRole(document.body.dataset.role));
