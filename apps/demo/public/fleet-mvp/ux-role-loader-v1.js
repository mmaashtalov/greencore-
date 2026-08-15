const UXRL_VERSION='2026.08.15-role11';
const loaded=new Set();
const bundles={
  admin:{
    css:[
      './driver-access-patch.css?v=20260815-1','./ux-waybills-list-v2.css?v=20260815-1','./ux-waybill-insight-v1.css?v=20260815-1','./ux-desktop-density-v1.css?v=20260815-1','./ux-vehicle-primary-v1.css?v=20260815-1','./ux-breadcrumb-v1.css?v=20260815-1','./ux-filter-v1.css?v=20260815-1','./ux-responsibility-v1.css?v=20260815-1','./ux-global-search-v1.css?v=20260815-1','./ux-recent-work-v1.css?v=20260815-1'
    ],
    js:[
      './ux-session-boundary-v1.js?v=20260815-2','./driver-access-patch.js?v=20260815-1','./ux-waybills-list-v2.js?v=20260815-1','./ux-waybill-insight-v1.js?v=20260815-1','./ux-vehicle-primary-v1.js?v=20260815-1','./ux-breadcrumb-v1.js?v=20260815-1','./ux-filter-v1.js?v=20260815-1','./ux-responsibility-v1.js?v=20260815-1','./ux-global-search-v1.js?v=20260815-3','./ux-recent-work-v1.js?v=20260815-1'
    ]
  },
  driver:{
    css:[
      './connectivity-patch.css?v=20260815-1','./ux-connectivity-v1.css?v=20260815-1','./driver-correction-patch.css?v=20260815-1','./driver-attention-patch.css?v=20260815-1','./ux-driver-state-v1.css?v=20260815-1','./ux-driver-form-v1.css?v=20260815-1','./ux-driver-draft-v1.css?v=20260815-1'
    ],
    js:[
      './ux-session-boundary-v1.js?v=20260815-2','./connectivity-patch.js?v=20260815-1','./ux-connectivity-v1.js?v=20260815-1','./offline-home-patch.js?v=20260815-2','./driver-correction-patch.js?v=20260815-1','./driver-attention-patch.js?v=20260815-2','./ux-driver-state-v1.js?v=20260815-1','./ux-driver-form-v1.js?v=20260815-1','./ux-driver-draft-v1.js?v=20260815-2'
    ]
  }
};
function loadCss(href){return new Promise(resolve=>{if(document.querySelector(`link[data-role-ux="${href}"]`)){resolve();return}const l=document.createElement('link');l.rel='stylesheet';l.href=href;l.dataset.roleUx=href;l.onload=()=>resolve();l.onerror=()=>resolve();document.head.appendChild(l)})}
async function loadRole(role){
  const bundle=bundles[role];
  if(!bundle||loaded.has(role))return;
  loaded.add(role);
  const started=performance.now();
  const cssReady=Promise.allSettled(bundle.css.map(loadCss));
  for(const src of bundle.js){
    try{await import(src)}catch(err){console.warn('Role UX module failed',src,err)}
  }
  await cssReady;
  window.dispatchEvent(new CustomEvent('fleet:role-ux-ready',{detail:{role,version:UXRL_VERSION,duration_ms:Math.round(performance.now()-started)}}));
}
window.addEventListener('fleet:ui-ready',e=>loadRole(e.detail?.role||document.body.dataset.role));
queueMicrotask(()=>loadRole(document.body.dataset.role));
