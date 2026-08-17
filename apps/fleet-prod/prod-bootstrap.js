const cfg=window.__FLEET_PROD_CONFIG__||{};
const DEMO_REF='tikjmiyrhkcjrxjylmqb';
function fail(message){
  const app=document.getElementById('app');
  if(app) app.innerHTML=`<main style="max-width:720px;margin:10vh auto;padding:24px;font:16px/1.5 system-ui"><h1>Контур не запущен</h1><p>${String(message).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}</p></main>`;
  throw new Error(message);
}
(async()=>{
  let url;
  try{url=new URL(cfg.supabaseUrl)}catch{fail('Не задан корректный SUPABASE_URL для production.')}
  if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')) fail('Production требует HTTPS Supabase endpoint.');
  if(url.hostname.startsWith(`${DEMO_REF}.`)) fail('Production запрещено запускать на fleet-mvp/demo базе.');
  if(typeof cfg.publishableKey!=='string'||!cfg.publishableKey.startsWith('sb_publishable_')) fail('Не задан production Supabase publishable key.');
  if(cfg.supabaseUrl.includes('__SUPABASE_')||cfg.publishableKey.includes('__SUPABASE_')) fail('Runtime-конфигурация production не подставлена при деплое.');

  await import('./prod-hardening-v1.js?v=20260817-3');
  const modules=[
    './app.js?v=20260814-1','./ux-runtime-v2.js?v=20260815-1','./ux-loading-v1.js?v=20260815-1','./ui-patch.js?v=20260815-4','./ux-bridge.js?v=20260815-2','./ux-polish-v2.js?v=20260815-3','./ux-dialog-v1.js?v=20260816-6','./ux-empty-v1.js?v=20260815-1','./ux-feedback-v1.js?v=20260815-1','./ux-freshness-v1.js?v=20260815-1','./ux-navigation-v1.js?v=20260815-1','./ux-return-state-v1.js?v=20260815-1','./ux-notify-v1.js?v=20260815-1','./ux-inbox-v1.js?v=20260816-5','./ux-login-v1.js?v=20260816-2','./ux-validation-v1.js?v=20260816-7','./ux-form-guard-v1.js?v=20260816-3','./ux-accessibility-v1.js?v=20260815-2','./ux-role-loader-v1.js?v=20260817-60','./maintenance-rules-admin-v1.js?v=20260816-1','./pwa-patch.js?v=20260815-2'
  ];
  for(const src of modules) await import(src);
  window.dispatchEvent(new CustomEvent('fleet:prod-bootstrap-ready',{detail:{version:'2026.08.17-bootstrap2'}}));
})().catch(err=>{console.error('Fleet production bootstrap failed',err)});
