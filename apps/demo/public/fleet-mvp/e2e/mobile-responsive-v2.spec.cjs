const { test, expect } = require('@playwright/test');

const APP='http://127.0.0.1:4173/fleet-mvp/';
const SUPABASE='https://tikjmiyrhkcjrxjylmqb.supabase.co';
const MOBILE_UA='Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36';
const portrait=[
  {name:'320x568',width:320,height:568},
  {name:'360x800',width:360,height:800},
  {name:'390x844',width:390,height:844},
  {name:'412x915',width:412,height:915},
  {name:'430x932',width:430,height:932}
];

function payload(rpc,role){
  if(rpc==='get_app_shell')return role==='driver'
    ?{role:'driver',navigation:[{id:'work',label:'Работа'},{id:'history',label:'История'}]}
    :{role:'admin',navigation:[{id:'home',label:'Главная'},{id:'fleet',label:'Техника'},{id:'service',label:'ТО и ремонт'},{id:'print',label:'Печать'}]};
  if(rpc==='get_admin_home')return{
    headline:'Автопарк',
    fleet:{total:27,operational:21,repair:4,unavailable:2},
    waybills:{active:14,waiting_review:3,needs_correction:2},incidents:{},attention_total:3,
    attention:[
      {id:'maintenance:vehicle-5046',label:'Плановое техническое обслуживание УРАЛ-4320-0811-31 (5046)',count:1,tone:'warning'},
      {id:'review:waybill-long-number',label:'Путевой лист требует проверки ответственным должностным лицом',count:2,tone:'info'}
    ],
    current_period:{label:'15.07.2026 — 15.08.2026'}
  };
  if(rpc==='get_fleet_list_ui')return{
    summary:{total:27,operational:21,repair:4,unavailable:2},
    items:[
      {id:'vehicle-5046',label:'УРАЛ-4320-0811-31 (5046) · автомобиль повышенной проходимости',subtitle:'А123АА 178 · подразделение материально-технического обеспечения',status_label:'В эксплуатации',tone:'success',attention:'Плановое техническое обслуживание через 500 км'},
      {id:'vehicle-long',label:'УАЗ-330365-112-91-TEST-LONG-UNBROKEN-IDENTIFIER-1234567890',subtitle:'Длинная строка используется для проверки переноса текста на узком экране',status_label:'В ремонте',tone:'warning'}
    ]
  };
  if(rpc==='get_service_center')return{
    title:'ТО и ремонт',subtitle:'Плановые работы, ремонты и неисправности техники',
    counters:{maintenance_due:6,in_repair:4,new_defects:2},
    attention:[{type:'maintenance',id:'maintenance:vehicle-5046',vehicle:'УРАЛ-4320-0811-31 (5046)',label:'Плановое ТО',detail:'Замена масла, фильтров и контроль ходовой части перед очередным длительным выездом',tone:'warning'}]
  };
  if(rpc==='get_print_center')return{
    title:'Печать',subtitle:'Путевые листы и сводные ведомости',sections:[
      {id:'waybills',total_count:1,items:[{id:'wb-1',number:'PL-2026-08-00000000000000000001',vehicle:'УРАЛ-4320-0811-31 (5046)',driver:'старший сержант Тестовый Водитель С Очень Длинной Фамилией',period:{from:'2026-08-01T00:00:00Z',to:'2026-08-10T00:00:00Z'},status_label:'Утвержден',print_mode:'final'}]},
      {id:'statements',total_count:1,items:[]}
    ]
  };
  if(rpc==='get_waybill_issue_form')return{
    title:'Выдать путевой лист',subtitle:'Заполните основные данные перед выдачей',
    vehicles:[{id:'vehicle-5046',label:'УРАЛ-4320-0811-31 (5046) · А123АА 178'}],
    drivers:[{id:'driver-1',rank:'старший сержант',label:'Тестовый Водитель С Очень Длинной Фамилией',categories:['B','C','CE'],license_valid_to:'2027-12-31'}],
    trailers:[{id:'trailer-1',label:'Прицеп специального назначения №123456789'}],
    employees:[{id:'employee-1',rank:'капитан',label:'Ответственный Сотрудник',position:'ответственный за эксплуатацию'}],
    defaults:{exploitation_group:'строевая'}
  };
  if(rpc==='get_waybill_issue_context_v3'||rpc==='get_waybill_issue_context_v2')return{
    vehicle:{required_categories:['C'],label:'УРАЛ-4320-0811-31 (5046)'},trailer:null,recommended_driver_id:'driver-1',
    drivers:[{id:'driver-1',rank:'старший сержант',label:'Тестовый Водитель С Очень Длинной Фамилией',categories:['B','C','CE'],license_valid_to:'2027-12-31',recommended:true}],
    defaults:{opening_odometer_km:123456,opening_fuel_l:180}
  };
  if(rpc==='get_vehicle_create_form')return{
    title:'Добавить технику',subtitle:'Карточка новой единицы техники',
    vehicle_classes:[{value:'truck',label:'Грузовой автомобиль',suggested_category:'C'},{value:'car',label:'Легковой автомобиль',suggested_category:'B'}],
    fuel_types:[{id:'diesel',label:'Дизельное топливо'}],license_categories:['B','C','CE']
  };
  if(rpc==='get_drivers_list_ui')return{items:[]};
  if(rpc==='get_waybills_list_ui')return{items:[]};
  if(rpc==='get_driver_home')return{
    user:{full_name:'старший сержант Тестовый Водитель С Очень Длинной Фамилией'},
    vehicle:{title:'УРАЛ-4320-0811-31',registration_number:'А123АА 178',internal_number:'5046'},
    waybill:{id:'wb-driver-1',number:'PL-2026-08-00000000000000000001',status_label:'В работе',last_odometer_km:123456,last_location:'Парк постоянной дислокации с длинным названием',route_points:8,refuel_count:2,fuel_received_l:145.5},
    primary_action:{id:'start_movement',label:'Зафиксировать выезд из парка',enabled:true},
    secondary_actions:[{id:'refuel',label:'Заправка',enabled:true},{id:'report_defect',label:'Сообщить о неисправности',enabled:true}]
  };
  if(rpc==='get_driver_history_ui')return{
    title:'История',subtitle:'Последние путевые листы',items:[{number:'PL-2026-07-00000000000000000009',vehicle:'УРАЛ-4320-0811-31 (5046)',period:{from:'2026-07-15T00:00:00Z',to:'2026-07-25T00:00:00Z'},mileage_km:847,fuel_received_l:240,status_label:'Закрыт'}]
  };
  if(rpc==='get_driver_action_form')return{
    title:'Зафиксировать выезд из парка',fields:[
      {id:'odometer_km',label:'Показания одометра',input:'number',required:true,default:123456},
      {id:'location_name',label:'Место выезда',input:'text',required:true,default:'Парк постоянной дислокации'},
      {id:'comment',label:'Комментарий к событию',control:'textarea',required:false,default:''}
    ],submit:{label:'Сохранить выезд',command:'record_departure'}
  };
  return{};
}

async function contextFor(browser,vp,role=null){
  const context=await browser.newContext({viewport:{width:vp.width,height:vp.height},userAgent:MOBILE_UA,isMobile:true,hasTouch:true,deviceScaleFactor:2});
  const page=await context.newPage();
  if(role){
    await page.addInitScript(({role})=>localStorage.setItem('fleet_mvp_session_v2',JSON.stringify({access_token:`e2e-${role}-access`,refresh_token:`e2e-${role}-refresh`,expires_at:4102444800,user:{id:`e2e-${role}`,email:`e2e-${role}@example.test`}})),{role});
    await page.route(`${SUPABASE}/**`,async route=>{
      const url=new URL(route.request().url());
      const marker='/rest/v1/rpc/';
      if(url.pathname.includes(marker)){
        const rpc=decodeURIComponent(url.pathname.split(marker)[1]);
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload(rpc,role))});
      }
      if(url.pathname.endsWith('/rest/v1/notifications'))return route.fulfill({status:200,contentType:'application/json',headers:{'content-range':'0-0/0'},body:'[]'});
      return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    });
  }
  return{context,page};
}

async function expectTitle(page,text){
  await expect(page.locator('.main .page-title')).toContainText(text,{timeout:7000});
  await expect(page.locator('#app > .splash')).toHaveCount(0);
  await expect(page.locator('.main .inline-loading')).toHaveCount(0);
}

async function expectRoleReady(page,role){
  await page.waitForFunction(r=>document.body.dataset.roleUxReady===r,role,{timeout:12000});
  const err=await page.locator('body').getAttribute('data-role-ux-error');
  expect(err,`${role} role hydration error`).toBeNull();
}

async function auditResponsive(page,label,{bottomNav=false,desktopNav=false}={}){
  const m=await page.evaluate(()=>{
    const root=document.documentElement,body=document.body,vw=root.clientWidth,vh=root.clientHeight;
    const allowed='.table-wrap,.print-stage,.uxd-dialog,.uxm-dialog,.svc-sheet,.uxgs-panel,.uxi-sheet';
    const visible=el=>{const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden'||Number(cs.opacity)===0)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0};
    const offenders=[];
    for(const el of document.querySelectorAll('body *')){
      if(!visible(el)||el.closest(allowed))continue;
      const r=el.getBoundingClientRect();
      if(r.right>vw+1||r.left<-1){offenders.push({tag:el.tagName,cls:String(el.className||'').slice(0,100),id:el.id||'',left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),text:String(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,100)});if(offenders.length>=12)break}
    }
    const shortButtons=[...document.querySelectorAll('button')].filter(visible).map(el=>({text:String(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,70),cls:String(el.className||'').slice(0,90),height:Math.round(el.getBoundingClientRect().height*10)/10,width:Math.round(el.getBoundingClientRect().width*10)/10})).filter(x=>x.height<43.5).slice(0,12);
    const smallFonts=[...document.querySelectorAll('input,select,textarea')].filter(el=>visible(el)&&el.type!=='hidden').map(el=>({name:el.name||el.id||el.tagName,size:parseFloat(getComputedStyle(el).fontSize)})).filter(x=>x.size<16).slice(0,12);
    const nav=document.querySelector('.bottom-nav'),desk=document.querySelector('.desktop-nav'),top=document.querySelector('.topbar');
    const rect=el=>el&&visible(el)?(()=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height}})():null;
    return{vw,vh,rootWidth:root.scrollWidth,bodyWidth:body.scrollWidth,offenders,shortButtons,smallFonts,nav:rect(nav),top:rect(top),desktop:!!(desk&&visible(desk))};
  });
  expect(m.offenders,`${label}: overflow offenders ${JSON.stringify(m.offenders)}`).toEqual([]);
  expect(m.rootWidth,`${label}: document horizontal scroll`).toBeLessThanOrEqual(m.vw+1);
  expect(m.bodyWidth,`${label}: body horizontal scroll`).toBeLessThanOrEqual(m.vw+1);
  expect(m.shortButtons,`${label}: touch targets below 44px ${JSON.stringify(m.shortButtons)}`).toEqual([]);
  expect(m.smallFonts,`${label}: mobile form font below 16px ${JSON.stringify(m.smallFonts)}`).toEqual([]);
  if(m.top){expect(m.top.left).toBeGreaterThanOrEqual(-1);expect(m.top.right).toBeLessThanOrEqual(m.vw+1)}
  if(bottomNav){expect(m.nav,`${label}: bottom nav missing`).not.toBeNull();expect(m.nav.left).toBeGreaterThanOrEqual(-1);expect(m.nav.right).toBeLessThanOrEqual(m.vw+1);expect(m.nav.bottom).toBeLessThanOrEqual(m.vh+1)}
  if(desktopNav)expect(m.desktop,`${label}: desktop nav missing in wide landscape`).toBe(true);
}

async function assertBottomContentClear(page,label){
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  await page.waitForTimeout(80);
  const x=await page.evaluate(()=>{
    const nav=document.querySelector('.bottom-nav'),main=document.querySelector('.main');
    if(!nav||getComputedStyle(nav).display==='none'||!main)return null;
    const visible=el=>{const cs=getComputedStyle(el);const r=el.getBoundingClientRect();return cs.display!=='none'&&cs.visibility!=='hidden'&&r.width>0&&r.height>0&&cs.position!=='fixed'};
    const children=[...main.children].filter(visible).filter(el=>!el.classList.contains('ux-driver-dock'));
    const last=children.at(-1);if(!last)return null;
    return{contentBottom:last.getBoundingClientRect().bottom,navTop:nav.getBoundingClientRect().top,last:String(last.className||last.tagName)};
  });
  if(x)expect(x.contentBottom,`${label}: ${x.last} remains behind fixed nav`).toBeLessThanOrEqual(x.navTop+1);
  await page.evaluate(()=>window.scrollTo(0,0));
}

for(const vp of portrait){
  test(`login responsive ${vp.name}`,async({browser})=>{
    const{context,page}=await contextFor(browser,vp);
    await page.goto(APP,{waitUntil:'domcontentloaded'});
    await expect(page.locator('#loginForm')).toBeVisible({timeout:5000});
    await auditResponsive(page,`login ${vp.name}`);
    await context.close();
  });

  test(`admin home responsive ${vp.name}`,async({browser})=>{
    const{context,page}=await contextFor(browser,vp,'admin');
    await page.goto(APP,{waitUntil:'domcontentloaded'});
    await expectTitle(page,'Автопарк');
    await expectRoleReady(page,'admin');
    await auditResponsive(page,`admin home ${vp.name}`,{bottomNav:vp.width<760});
    if(vp.width<760)await assertBottomContentClear(page,`admin home ${vp.name}`);
    await context.close();
  });
}

for(const vp of [portrait[0],portrait[2],portrait[4]]){
  test(`admin flow responsive ${vp.name}`,async({browser})=>{
    const{context,page}=await contextFor(browser,vp,'admin');
    await page.goto(APP,{waitUntil:'domcontentloaded'});
    await expectTitle(page,'Автопарк');await expectRoleReady(page,'admin');

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="fleet"]').click();
    await expectTitle(page,'Техника');await auditResponsive(page,`fleet ${vp.name}`,{bottomNav:true});

    await page.locator('[data-action="add-vehicle"]').click();
    await expectTitle(page,'Добавить технику');await auditResponsive(page,`vehicle form ${vp.name}`,{bottomNav:true});await assertBottomContentClear(page,`vehicle form ${vp.name}`);

    await page.locator('.back-btn').click();await expectTitle(page,'Техника');
    await page.locator('.bottom-nav [data-action="main-nav"][data-id="service"]').click();
    await expectTitle(page,'ТО и ремонт');await auditResponsive(page,`service ${vp.name}`,{bottomNav:true});

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="print"]').click();
    await expectTitle(page,'Печать');await auditResponsive(page,`print ${vp.name}`,{bottomNav:true});

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="home"]').click();await expectTitle(page,'Автопарк');
    await page.locator('[data-action="issue-waybill"]').first().click();
    await expectTitle(page,'Выдать путевой лист');await auditResponsive(page,`issue waybill ${vp.name}`,{bottomNav:true});await assertBottomContentClear(page,`issue waybill ${vp.name}`);
    await context.close();
  });
}

for(const vp of [portrait[0],portrait[1],portrait[3],portrait[4]]){
  test(`driver flow responsive ${vp.name}`,async({browser})=>{
    const{context,page}=await contextFor(browser,vp,'driver');
    await page.goto(APP,{waitUntil:'domcontentloaded'});
    await expectTitle(page,'Моя машина');await expectRoleReady(page,'driver');
    await auditResponsive(page,`driver work ${vp.name}`,{bottomNav:true});await assertBottomContentClear(page,`driver work ${vp.name}`);

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="history"]').click();
    await expectTitle(page,'История');await auditResponsive(page,`driver history ${vp.name}`,{bottomNav:true});

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="work"]').click();await expectTitle(page,'Моя машина');
    await page.locator('[data-action="driver-action"]').first().click();
    await expectTitle(page,'Зафиксировать выезд');await auditResponsive(page,`driver action ${vp.name}`,{bottomNav:true});await assertBottomContentClear(page,`driver action ${vp.name}`);
    await context.close();
  });
}

test('landscape phone responsive 844x390',async({browser})=>{
  const vp={width:844,height:390};const{context,page}=await contextFor(browser,vp,'admin');
  await page.goto(APP,{waitUntil:'domcontentloaded'});await expectTitle(page,'Автопарк');await expectRoleReady(page,'admin');
  await auditResponsive(page,'admin landscape 844x390',{desktopNav:true});await context.close();
});
