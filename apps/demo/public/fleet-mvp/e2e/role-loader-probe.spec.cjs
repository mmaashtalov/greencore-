const { test } = require('@playwright/test');

const APP='http://127.0.0.1:4173/fleet-mvp/';
const SUPABASE='https://tikjmiyrhkcjrxjylmqb.supabase.co';
const UA='Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36';

function rpcPayload(name){
  if(name==='get_app_shell')return {role:'admin',navigation:[{id:'home',label:'Главная'},{id:'fleet',label:'Техника'},{id:'service',label:'ТО и ремонт'},{id:'print',label:'Печать'}]};
  if(name==='get_admin_home')return {headline:'Автопарк',fleet:{total:27,operational:21,repair:4,unavailable:2},waybills:{active:14,waiting_review:3,needs_correction:2},incidents:{},attention_total:2,attention:[{id:'maintenance:one',label:'Плановое ТО',count:1,tone:'warning'},{id:'review:one',label:'Проверка ПЛ',count:1,tone:'info'}],current_period:{label:'15.07.2026 — 15.08.2026'}};
  if(name==='get_fleet_list_ui')return {summary:{total:0},items:[]};
  if(name==='get_drivers_list_ui')return {items:[]};
  if(name==='get_waybills_list_ui')return {items:[]};
  return {};
}

test('probe admin role imports until UI starvation',async({browser})=>{
  const context=await browser.newContext({viewport:{width:360,height:800},userAgent:UA,isMobile:true,hasTouch:true,deviceScaleFactor:2});
  const page=await context.newPage();
  const seen=[];
  page.on('request',req=>{
    const u=new URL(req.url());
    if(u.origin==='http://127.0.0.1:4173'&&u.pathname.startsWith('/fleet-mvp/')&&u.pathname.endsWith('.js')){
      const file=u.pathname.split('/').pop();
      seen.push(file);
      console.log(`ROLE_PROBE_JS ${String(seen.length).padStart(2,'0')} ${file}`);
    }
  });
  await page.addInitScript(()=>localStorage.setItem('fleet_mvp_session_v2',JSON.stringify({access_token:'probe-admin',refresh_token:'probe-refresh',expires_at:4102444800,user:{id:'probe-admin',email:'probe@example.test'}})));
  await page.route(`${SUPABASE}/**`,async route=>{
    const url=new URL(route.request().url());
    const marker='/rest/v1/rpc/';
    if(url.pathname.includes(marker)){
      const name=decodeURIComponent(url.pathname.split(marker)[1]);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(rpcPayload(name))});
    }
    if(url.pathname.endsWith('/rest/v1/notifications'))return route.fulfill({status:200,contentType:'application/json',headers:{'content-range':'0-0/0'},body:'[]'});
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForTimeout(8000);
  console.log(`ROLE_PROBE_LAST ${seen.at(-1)||'none'}`);
  console.log(`ROLE_PROBE_COUNT ${seen.length}`);
  // Runner-side request events above remain available even when page JS starves.
  await context.close().catch(()=>{});
});
