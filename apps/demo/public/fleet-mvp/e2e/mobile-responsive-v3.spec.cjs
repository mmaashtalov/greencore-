const { test, expect } = require('@playwright/test');

const APP='http://127.0.0.1:4173/fleet-mvp/';
const SUPABASE='https://tikjmiyrhkcjrxjylmqb.supabase.co';
const UA='Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36';
const PORTRAIT=[
  ['320x568',320,568],['360x800',360,800],['390x844',390,844],['412x915',412,915],['430x932',430,932]
].map(([name,width,height])=>({name,width,height}));

function data(rpc,role){
  if(rpc==='get_app_shell')return role==='driver'
    ?{role:'driver',navigation:[{id:'work',label:'Работа'},{id:'history',label:'История'}]}
    :{role:'admin',navigation:[{id:'home',label:'Главная'},{id:'fleet',label:'Техника'},{id:'service',label:'ТО и ремонт'},{id:'print',label:'Печать'}]};
  if(rpc==='get_admin_home')return{headline:'Автопарк',fleet:{total:27,operational:21,repair:4,unavailable:2},waybills:{active:14,waiting_review:3,needs_correction:2},incidents:{},attention_total:3,attention:[{id:'maintenance:5046',label:'Плановое техническое обслуживание УРАЛ-4320-0811-31 (5046)',count:1,tone:'warning'},{id:'review:long',label:'Путевой лист требует проверки ответственным должностным лицом',count:2,tone:'info'}],current_period:{label:'15.07.2026 — 15.08.2026'}};
  if(rpc==='get_fleet_list_ui')return{summary:{total:27,operational:21,repair:4,unavailable:2},items:[{id:'v1',label:'УРАЛ-4320-0811-31 (5046) · автомобиль повышенной проходимости',subtitle:'А123АА 178 · подразделение материально-технического обеспечения',status_label:'В эксплуатации',tone:'success',attention:'Плановое техническое обслуживание через 500 км'},{id:'v2',label:'УАЗ-330365-112-91-TEST-LONG-UNBROKEN-IDENTIFIER-1234567890',subtitle:'Проверка переноса длинной строки на узком экране',status_label:'В ремонте',tone:'warning'}]};
  if(rpc==='get_service_center')return{title:'ТО и ремонт',subtitle:'Плановые работы, ремонты и неисправности техники',counters:{maintenance_due:6,in_repair:4,new_defects:2},attention:[{type:'maintenance',id:'m1',vehicle:'УРАЛ-4320-0811-31 (5046)',label:'Плановое ТО',detail:'Замена масла, фильтров и контроль ходовой части перед очередным длительным выездом',tone:'warning'}]};
  if(rpc==='get_print_center')return{title:'Печать',subtitle:'Путевые листы и сводные ведомости',sections:[{id:'waybills',total_count:1,items:[{id:'wb1',number:'PL-2026-08-00000000000000000001',vehicle:'УРАЛ-4320-0811-31 (5046)',driver:'старший сержант Тестовый Водитель С Очень Длинной Фамилией',period:{from:'2026-08-01T00:00:00Z',to:'2026-08-10T00:00:00Z'},status_label:'Утвержден',print_mode:'final'}]},{id:'statements',total_count:1,items:[]}]};
  if(rpc==='get_vehicle_create_form')return{title:'Добавить технику',subtitle:'Карточка новой единицы техники',vehicle_classes:[{value:'truck',label:'Грузовой автомобиль',suggested_category:'C'}],fuel_types:[{id:'diesel',label:'Дизельное топливо'}],license_categories:['B','C','CE']};
  if(rpc==='get_waybill_issue_form')return{title:'Выдать путевой лист',subtitle:'Заполните основные данные перед выдачей',vehicles:[{id:'v1',label:'УРАЛ-4320-0811-31 (5046) · А123АА 178'}],drivers:[{id:'d1',rank:'старший сержант',label:'Тестовый Водитель С Очень Длинной Фамилией',categories:['B','C','CE'],license_valid_to:'2027-12-31'}],trailers:[{id:'t1',label:'Прицеп специального назначения №123456789'}],employees:[{id:'e1',rank:'капитан',label:'Ответственный Сотрудник',position:'ответственный за эксплуатацию'}],defaults:{exploitation_group:'строевая'}};
  if(rpc==='get_waybill_issue_context_v3'||rpc==='get_waybill_issue_context_v2')return{vehicle:{required_categories:['C'],label:'УРАЛ-4320-0811-31 (5046)'},trailer:null,recommended_driver_id:'d1',drivers:[{id:'d1',rank:'старший сержант',label:'Тестовый Водитель С Очень Длинной Фамилией',categories:['B','C','CE'],license_valid_to:'2027-12-31',recommended:true}],defaults:{opening_odometer_km:123456,opening_fuel_l:180}};
  if(rpc==='get_drivers_list_ui'||rpc==='get_waybills_list_ui')return{items:[]};
  if(rpc==='get_driver_home')return{user:{full_name:'старший сержант Тестовый Водитель С Очень Длинной Фамилией'},vehicle:{title:'УРАЛ-4320-0811-31',registration_number:'А123АА 178',internal_number:'5046'},waybill:{id:'wd1',number:'PL-2026-08-00000000000000000001',status_label:'В работе',last_odometer_km:123456,last_location:'Парк постоянной дислокации с длинным названием',route_points:8,refuel_count:2,fuel_received_l:145.5},primary_action:{id:'start_movement',label:'Зафиксировать выезд из парка',enabled:true},secondary_actions:[{id:'refuel',label:'Заправка',enabled:true},{id:'report_defect',label:'Сообщить о неисправности',enabled:true}]};
  if(rpc==='get_driver_history_ui')return{title:'История',subtitle:'Последние путевые листы',items:[{number:'PL-2026-07-00000000000000000009',vehicle:'УРАЛ-4320-0811-31 (5046)',period:{from:'2026-07-15T00:00:00Z',to:'2026-07-25T00:00:00Z'},mileage_km:847,fuel_received_l:240,status_label:'Закрыт'}]};
  if(rpc==='get_driver_action_form')return{title:'Зафиксировать выезд из парка',fields:[{id:'odometer_km',label:'Показания одометра',input:'number',required:true,default:123456},{id:'location_name',label:'Место выезда',input:'text',required:true,default:'Парк постоянной дислокации'},{id:'comment',label:'Комментарий к событию',control:'textarea',required:false,default:''}],submit:{label:'Сохранить выезд',command:'record_departure'}};
  return{};
}

async function open(browser,vp,role){
  const context=await browser.newContext({viewport:{width:vp.width,height:vp.height},userAgent:UA,isMobile:true,hasTouch:true,deviceScaleFactor:2});
  const page=await context.newPage();
  if(role){
    await page.addInitScript(({role})=>localStorage.setItem('fleet_mvp_session_v2',JSON.stringify({access_token:`e2e-${role}`,refresh_token:`refresh-${role}`,expires_at:4102444800,user:{id:`e2e-${role}`,email:`${role}@example.test`}})),{role});
    await page.route(`${SUPABASE}/**`,async route=>{
      const url=new URL(route.request().url()),marker='/rest/v1/rpc/';
      if(url.pathname.includes(marker))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data(decodeURIComponent(url.pathname.split(marker)[1]),role))});
      if(url.pathname.endsWith('/rest/v1/notifications'))return route.fulfill({status:200,contentType:'application/json',headers:{'content-range':'0-0/0'},body:'[]'});
      return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    });
  }
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  return{context,page};
}

async function title(page,text){
  await expect(page.locator('.main .page-title')).toContainText(text,{timeout:7000});
  await expect(page.locator('#app > .splash')).toHaveCount(0);
  await expect(page.locator('.main .inline-loading')).toHaveCount(0);
}
async function roleReady(page,role){
  await page.waitForFunction(r=>document.body.dataset.roleUxReady===r,role,{timeout:12000});
  expect(await page.locator('body').getAttribute('data-role-ux-error')).toBeNull();
}

async function audit(page,label,{bottom=false,desktop=false}={}){
  const m=await page.evaluate(()=>{
    const root=document.documentElement,body=document.body,vw=root.clientWidth,vh=root.clientHeight;
    const allowed='.table-wrap,.print-stage,.uxd-dialog,.uxm-dialog,.svc-sheet,.uxgs-panel,.uxi-sheet';
    const visible=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0};
    const offenders=[];
    for(const el of document.querySelectorAll('body *')){if(!visible(el)||el.closest(allowed))continue;const r=el.getBoundingClientRect();if(r.right>vw+1||r.left<-1){offenders.push({tag:el.tagName,cls:String(el.className||'').slice(0,90),left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),text:String(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,80)});if(offenders.length===10)break}}
    const short=[...document.querySelectorAll('button')].filter(visible).map(el=>({text:String(el.textContent||'').trim().slice(0,60),h:Math.round(el.getBoundingClientRect().height*10)/10})).filter(x=>x.h<43.5).slice(0,10);
    const fonts=[...document.querySelectorAll('input,select,textarea')].filter(el=>visible(el)&&el.type!=='hidden').map(el=>({name:el.name||el.id||el.tagName,size:parseFloat(getComputedStyle(el).fontSize)})).filter(x=>x.size<16).slice(0,10);
    const rect=el=>el&&visible(el)?(()=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom}})():null;
    return{vw,vh,rootWidth:root.scrollWidth,bodyWidth:body.scrollWidth,offenders,short,fonts,nav:rect(document.querySelector('.bottom-nav')),top:rect(document.querySelector('.topbar')),desktop:!!rect(document.querySelector('.desktop-nav'))};
  });
  expect(m.offenders,`${label}: overflow ${JSON.stringify(m.offenders)}`).toEqual([]);
  expect(m.rootWidth,`${label}: root horizontal scroll`).toBeLessThanOrEqual(m.vw+1);
  expect(m.bodyWidth,`${label}: body horizontal scroll`).toBeLessThanOrEqual(m.vw+1);
  expect(m.short,`${label}: sub-44px touch targets ${JSON.stringify(m.short)}`).toEqual([]);
  expect(m.fonts,`${label}: sub-16px form fonts ${JSON.stringify(m.fonts)}`).toEqual([]);
  if(m.top){expect(m.top.left).toBeGreaterThanOrEqual(-1);expect(m.top.right).toBeLessThanOrEqual(m.vw+1)}
  if(bottom){expect(m.nav).not.toBeNull();expect(m.nav.left).toBeGreaterThanOrEqual(-1);expect(m.nav.right).toBeLessThanOrEqual(m.vw+1);expect(m.nav.bottom).toBeLessThanOrEqual(m.vh+1)}
  if(desktop)expect(m.desktop).toBe(true);
}

async function clearOfNav(page,label){
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(60);
  const x=await page.evaluate(()=>{const nav=document.querySelector('.bottom-nav'),main=document.querySelector('.main');if(!nav||getComputedStyle(nav).display==='none'||!main)return null;const visible=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&s.position!=='fixed'&&r.width>0&&r.height>0};const last=[...main.children].filter(visible).filter(el=>!el.classList.contains('ux-driver-dock')).at(-1);return last?{content:last.getBoundingClientRect().bottom,nav:nav.getBoundingClientRect().top,cls:String(last.className||last.tagName)}:null});
  if(x)expect(x.content,`${label}: ${x.cls} behind fixed nav`).toBeLessThanOrEqual(x.nav+1);
  await page.evaluate(()=>window.scrollTo(0,0));
}

for(const vp of PORTRAIT){
  test(`login ${vp.name}`,async({browser})=>{const{context,page}=await open(browser,vp);await expect(page.locator('#loginForm')).toBeVisible({timeout:5000});await audit(page,`login ${vp.name}`);await context.close()});
  test(`admin home ${vp.name}`,async({browser})=>{const{context,page}=await open(browser,vp,'admin');await title(page,'Автопарк');await roleReady(page,'admin');await audit(page,`admin ${vp.name}`,{bottom:true});await clearOfNav(page,`admin ${vp.name}`);await context.close()});
}

for(const vp of [PORTRAIT[0],PORTRAIT[2],PORTRAIT[4]]){
  test(`admin core flow ${vp.name}`,async({browser})=>{
    const{context,page}=await open(browser,vp,'admin');await title(page,'Автопарк');await roleReady(page,'admin');
    await page.locator('.bottom-nav [data-id="fleet"]').click();await title(page,'Техника');await audit(page,`fleet ${vp.name}`,{bottom:true});
    await page.locator('[data-action="add-vehicle"]').click();await title(page,'Добавить технику');await audit(page,`vehicle form ${vp.name}`,{bottom:true});await clearOfNav(page,`vehicle form ${vp.name}`);
    await page.locator('.back-btn').click();await title(page,'Техника');
    await page.locator('.bottom-nav [data-id="service"]').click();await title(page,'ТО и ремонт');await audit(page,`service ${vp.name}`,{bottom:true});
    await page.locator('.bottom-nav [data-id="print"]').click();await title(page,'Печать');await audit(page,`print ${vp.name}`,{bottom:true});
    await page.locator('.bottom-nav [data-id="home"]').click();await title(page,'Автопарк');
    await page.locator('[data-action="issue-waybill"]').first().click();await title(page,'Выдать путевой лист');await audit(page,`issue ${vp.name}`,{bottom:true});await clearOfNav(page,`issue ${vp.name}`);
    await context.close();
  });
}

for(const vp of [PORTRAIT[0],PORTRAIT[1],PORTRAIT[3],PORTRAIT[4]]){
  test(`driver core flow ${vp.name}`,async({browser})=>{
    const{context,page}=await open(browser,vp,'driver');await title(page,'Моя машина');await roleReady(page,'driver');await audit(page,`driver ${vp.name}`,{bottom:true});await clearOfNav(page,`driver ${vp.name}`);
    await expect(page.locator('.hero .ux-source-primary')).toBeHidden();
    await expect(page.locator('.ux-driver-dock [data-action="driver-action"]')).toBeVisible();
    await page.locator('.bottom-nav [data-id="history"]').click();await title(page,'История');await audit(page,`history ${vp.name}`,{bottom:true});
    await page.locator('.bottom-nav [data-id="work"]').click();await title(page,'Моя машина');
    const dockAction=page.locator('.ux-driver-dock [data-action="driver-action"]');await expect(dockAction).toBeVisible();await dockAction.click();
    await title(page,'Зафиксировать выезд');await audit(page,`driver action ${vp.name}`,{bottom:true});await clearOfNav(page,`driver action ${vp.name}`);
    await context.close();
  });
}

test('landscape 844x390',async({browser})=>{const{context,page}=await open(browser,{width:844,height:390},'admin');await title(page,'Автопарк');await roleReady(page,'admin');await audit(page,'landscape 844x390',{desktop:true});await context.close()});
