const {test,expect}=require('@playwright/test');

const BASE=process.env.FLEET_E2E_BASE_URL||'http://127.0.0.1:4173';
const DEMO_HOST='tikjmiyrhkcjrxjylmqb.supabase.co';
const FAKE_PROD_URL='https://abcdefghijklmnopqrst.supabase.co';
const FAKE_KEY='sb_publishable_prod_e2e_contract_only';

async function runtimeConfig(page,url,key){
  await page.route('**/runtime-config.js*',route=>route.fulfill({
    status:200,
    contentType:'application/javascript; charset=utf-8',
    body:`window.__FLEET_PROD_CONFIG__=Object.freeze({supabaseUrl:${JSON.stringify(url)},publishableKey:${JSON.stringify(key)}});`
  }));
}

test('fails closed when deployment config is not injected',async({page})=>{
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await expect(page.getByRole('heading',{name:'Контур не запущен'})).toBeVisible();
  await expect(page.getByText(/Runtime-конфигурация production не подставлена/)).toBeVisible();
});

test('explicitly refuses the fleet-mvp demo Supabase backend',async({page})=>{
  await runtimeConfig(page,`https://${DEMO_HOST}`,FAKE_KEY);
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await expect(page.getByRole('heading',{name:'Контур не запущен'})).toBeVisible();
  await expect(page.getByText(/Production запрещено запускать на fleet-mvp\/demo базе/)).toBeVisible();
});

test('production bootstrap starts with a non-demo backend and leaks no request to demo Supabase',async({page})=>{
  const demoRequests=[];
  page.on('request',request=>{if(new URL(request.url()).hostname===DEMO_HOST)demoRequests.push(request.url())});
  await runtimeConfig(page,FAKE_PROD_URL,FAKE_KEY);
  await page.route('https://abcdefghijklmnopqrst.supabase.co/**',route=>route.fulfill({status:401,contentType:'application/json',body:'{"message":"E2E synthetic backend"}'}));
  await page.goto(BASE,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#email')).toHaveValue('');
  await expect(page.locator('.login-sub')).toHaveText('Защищённый рабочий контур');
  await expect(page.locator('.demo-note')).toBeHidden();
  await expect(page).toHaveTitle('АСУ Автопарк');
  expect(demoRequests).toEqual([]);
});
