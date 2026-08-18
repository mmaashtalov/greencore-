const { test, expect } = require('@playwright/test');

const APP = 'http://127.0.0.1:4173/fleet-mvp/';
const SUPABASE = 'https://tikjmiyrhkcjrxjylmqb.supabase.co';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36';

const portraitMatrix = [
  { name: '320x568', width: 320, height: 568 },
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '412x915', width: 412, height: 915 },
  { name: '430x932', width: 430, height: 932 }
];

function payloadFor(rpc, role) {
  if (rpc === 'get_app_shell') {
    return role === 'driver'
      ? {
          role: 'driver',
          navigation: [
            { id: 'work', label: 'Работа' },
            { id: 'history', label: 'История' }
          ]
        }
      : {
          role: 'admin',
          navigation: [
            { id: 'home', label: 'Главная' },
            { id: 'fleet', label: 'Техника' },
            { id: 'service', label: 'ТО и ремонт' },
            { id: 'print', label: 'Печать' }
          ]
        };
  }

  if (rpc === 'get_admin_home') {
    return {
      headline: 'Автопарк',
      fleet: { total: 27, operational: 21, repair: 4, unavailable: 2 },
      waybills: { active: 14, waiting_review: 3, needs_correction: 2 },
      incidents: {},
      attention_total: 3,
      attention: [
        {
          id: 'maintenance:vehicle-5046',
          label: 'Плановое техническое обслуживание УРАЛ-4320-0811-31 (5046)',
          count: 1,
          tone: 'warning'
        },
        {
          id: 'review:waybill-long-number',
          label: 'Путевой лист требует проверки ответственным должностным лицом',
          count: 2,
          tone: 'info'
        }
      ],
      current_period: { label: '15.07.2026 — 15.08.2026' }
    };
  }

  if (rpc === 'get_fleet_list_ui') {
    return {
      summary: { total: 27, operational: 21, repair: 4, unavailable: 2 },
      items: [
        {
          id: 'vehicle-5046',
          label: 'УРАЛ-4320-0811-31 (5046) · автомобиль повышенной проходимости',
          subtitle: 'А123АА 178 · подразделение материально-технического обеспечения',
          status_label: 'В эксплуатации',
          tone: 'success',
          attention: 'Плановое техническое обслуживание через 500 км'
        },
        {
          id: 'vehicle-very-long',
          label: 'УАЗ-330365-112-91-TEST-LONG-UNBROKEN-IDENTIFIER-1234567890',
          subtitle: 'Длинная строка используется для проверки переноса текста на узком экране',
          status_label: 'В ремонте',
          tone: 'warning'
        }
      ]
    };
  }

  if (rpc === 'get_service_center') {
    return {
      title: 'ТО и ремонт',
      subtitle: 'Плановые работы, ремонты и неисправности техники',
      counters: { maintenance_due: 6, in_repair: 4, overdue: 2 },
      attention: [
        {
          type: 'maintenance',
          id: 'maintenance:vehicle-5046',
          vehicle: 'УРАЛ-4320-0811-31 (5046)',
          label: 'Плановое ТО',
          detail: 'Замена масла, фильтров и контроль ходовой части перед очередным длительным выездом',
          tone: 'warning'
        }
      ]
    };
  }

  if (rpc === 'get_print_center') {
    return {
      title: 'Печать',
      subtitle: 'Путевые листы и сводные ведомости',
      sections: [
        {
          id: 'waybills',
          total_count: 1,
          items: [
            {
              id: 'wb-1',
              number: 'PL-2026-08-00000000000000000001',
              vehicle: 'УРАЛ-4320-0811-31 (5046)',
              driver: 'старший сержант Тестовый Водитель С Очень Длинной Фамилией',
              period: { from: '2026-08-01T00:00:00Z', to: '2026-08-10T00:00:00Z' },
              status_label: 'Утвержден',
              print_mode: 'final'
            }
          ]
        },
        {
          id: 'statements',
          total_count: 1,
          items: []
        }
      ]
    };
  }

  if (rpc === 'get_waybill_issue_form') {
    return {
      title: 'Выдать путевой лист',
      subtitle: 'Заполните основные данные перед выдачей',
      vehicles: [{ id: 'vehicle-5046', label: 'УРАЛ-4320-0811-31 (5046) · А123АА 178' }],
      drivers: [{ id: 'driver-1', rank: 'старший сержант', label: 'Тестовый Водитель С Очень Длинной Фамилией', categories: ['B', 'C', 'CE'] }],
      trailers: [{ id: 'trailer-1', label: 'Прицеп специального назначения №123456789' }],
      employees: [{ id: 'employee-1', rank: 'капитан', label: 'Ответственный Сотрудник' }],
      defaults: { exploitation_group: 'строевая' }
    };
  }

  if (rpc === 'get_vehicle_create_form') {
    return {
      title: 'Добавить технику',
      subtitle: 'Карточка новой единицы техники',
      vehicle_classes: [
        { value: 'truck', label: 'Грузовой автомобиль', suggested_category: 'C' },
        { value: 'car', label: 'Легковой автомобиль', suggested_category: 'B' }
      ],
      fuel_types: [{ id: 'diesel', label: 'Дизельное топливо' }],
      license_categories: ['B', 'C', 'CE']
    };
  }

  if (rpc === 'get_driver_home') {
    return {
      user: { full_name: 'старший сержант Тестовый Водитель С Очень Длинной Фамилией' },
      vehicle: {
        title: 'УРАЛ-4320-0811-31',
        registration_number: 'А123АА 178',
        internal_number: '5046'
      },
      waybill: {
        id: 'wb-driver-1',
        number: 'PL-2026-08-00000000000000000001',
        status_label: 'В работе',
        last_odometer_km: 123456,
        last_location: 'Парк постоянной дислокации с длинным названием',
        route_points: 8,
        refuel_count: 2,
        fuel_received_l: 145.5
      },
      primary_action: { id: 'depart', label: 'Зафиксировать выезд из парка', enabled: true },
      secondary_actions: [
        { id: 'refuel', label: 'Заправка' },
        { id: 'report_defect', label: 'Сообщить о неисправности' }
      ]
    };
  }

  if (rpc === 'get_driver_history_ui') {
    return {
      title: 'История',
      subtitle: 'Последние путевые листы',
      items: [
        {
          number: 'PL-2026-07-00000000000000000009',
          vehicle: 'УРАЛ-4320-0811-31 (5046)',
          period: { from: '2026-07-15T00:00:00Z', to: '2026-07-25T00:00:00Z' },
          mileage_km: 847,
          fuel_received_l: 240,
          status_label: 'Закрыт'
        }
      ]
    };
  }

  if (rpc === 'get_driver_action_form') {
    return {
      title: 'Зафиксировать выезд из парка',
      fields: [
        { id: 'odometer_km', label: 'Показания одометра', input: 'number', required: true, default: 123456 },
        { id: 'location', label: 'Место выезда', input: 'text', required: true, default: 'Парк постоянной дислокации' },
        { id: 'comment', label: 'Комментарий к событию', control: 'textarea', required: false, default: '' }
      ],
      submit: { label: 'Сохранить выезд' }
    };
  }

  return {};
}

async function prepareAuthenticatedPage(page, role = 'admin') {
  await page.addInitScript(({ role }) => {
    localStorage.setItem('fleet_mvp_session_v2', JSON.stringify({
      access_token: `e2e-${role}-access-token`,
      refresh_token: `e2e-${role}-refresh-token`,
      expires_at: 4102444800,
      user: { id: `e2e-${role}`, email: `e2e-${role}@example.test` }
    }));
  }, { role });

  await page.route(`${SUPABASE}/**`, async route => {
    const url = new URL(route.request().url());
    const marker = '/rest/v1/rpc/';
    if (url.pathname.includes(marker)) {
      const rpc = decodeURIComponent(url.pathname.split(marker)[1]);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payloadFor(rpc, role))
      });
    }
    if (url.pathname.endsWith('/rest/v1/notifications')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function expectTitle(page, text) {
  await expect(page.locator('.main .page-title')).toContainText(text, { timeout: 7000 });
  await expect(page.locator('#app > .splash')).toHaveCount(0);
  await expect(page.locator('.main .inline-loading')).toHaveCount(0);
}

async function auditResponsive(page, label, options = {}) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const vw = root.clientWidth;
    const vh = root.clientHeight;
    const allowedOverflow = '.table-wrap,.print-stage,.uxd-dialog,.uxm-dialog';
    const visible = el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const overflowOffenders = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || el.closest(allowedOverflow)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 || r.left < -1) {
        overflowOffenders.push({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 120),
          id: el.id || '',
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)
        });
        if (overflowOffenders.length >= 12) break;
      }
    }

    const shortButtons = [...document.querySelectorAll('button')]
      .filter(visible)
      .map(el => ({
        text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        cls: String(el.className || '').slice(0, 100),
        height: Math.round(el.getBoundingClientRect().height * 10) / 10
      }))
      .filter(x => x.height < 43.5)
      .slice(0, 12);

    const smallFormFonts = [...document.querySelectorAll('input,select,textarea')]
      .filter(el => visible(el) && el.type !== 'hidden')
      .map(el => ({
        name: el.name || el.id || el.tagName,
        cls: String(el.className || '').slice(0, 100),
        size: parseFloat(getComputedStyle(el).fontSize)
      }))
      .filter(x => x.size < 16)
      .slice(0, 12);

    const topbar = document.querySelector('.topbar');
    const bottomNav = document.querySelector('.bottom-nav');
    const desktopNav = document.querySelector('.desktop-nav');
    const topRect = topbar && visible(topbar) ? topbar.getBoundingClientRect() : null;
    const bottomRect = bottomNav && visible(bottomNav) ? bottomNav.getBoundingClientRect() : null;

    return {
      viewport: { width: vw, height: vh },
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body.scrollWidth,
      overflowOffenders,
      shortButtons,
      smallFormFonts,
      topbar: topRect ? { left: topRect.left, right: topRect.right, top: topRect.top, bottom: topRect.bottom, height: topRect.height } : null,
      bottomNav: bottomRect ? { left: bottomRect.left, right: bottomRect.right, top: bottomRect.top, bottom: bottomRect.bottom, height: bottomRect.height } : null,
      desktopNavVisible: Boolean(desktopNav && visible(desktopNav))
    };
  });

  expect(metrics.rootScrollWidth, `${label}: document must not scroll horizontally`).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.bodyScrollWidth, `${label}: body must not scroll horizontally`).toBeLessThanOrEqual(metrics.viewport.width + 1);
  expect(metrics.overflowOffenders, `${label}: visible elements must stay inside the viewport`).toEqual([]);
  expect(metrics.shortButtons, `${label}: coarse-pointer buttons must keep a 44px touch target`).toEqual([]);
  expect(metrics.smallFormFonts, `${label}: mobile form controls must use at least 16px text to avoid browser auto-zoom`).toEqual([]);

  if (metrics.topbar) {
    expect(metrics.topbar.left, `${label}: topbar left edge`).toBeGreaterThanOrEqual(-1);
    expect(metrics.topbar.right, `${label}: topbar right edge`).toBeLessThanOrEqual(metrics.viewport.width + 1);
  }

  if (options.bottomNav === true) {
    expect(metrics.bottomNav, `${label}: mobile bottom navigation must be visible`).not.toBeNull();
    expect(metrics.bottomNav.bottom, `${label}: bottom nav must remain inside viewport`).toBeLessThanOrEqual(metrics.viewport.height + 1);
    expect(metrics.bottomNav.left, `${label}: bottom nav left edge`).toBeGreaterThanOrEqual(-1);
    expect(metrics.bottomNav.right, `${label}: bottom nav right edge`).toBeLessThanOrEqual(metrics.viewport.width + 1);
  }

  if (options.desktopNav === true) {
    expect(metrics.desktopNavVisible, `${label}: landscape wide layout should expose navigation`).toBe(true);
  }
}

async function assertBottomContentClearOfNav(page, label) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(50);
  const overlap = await page.evaluate(() => {
    const nav = document.querySelector('.bottom-nav');
    const main = document.querySelector('.main');
    if (!nav || getComputedStyle(nav).display === 'none' || !main) return null;
    const n = nav.getBoundingClientRect();
    const m = main.getBoundingClientRect();
    return { mainBottom: m.bottom, navTop: n.top };
  });
  if (overlap) {
    expect(overlap.mainBottom, `${label}: last content must be scrollable above fixed navigation`).toBeLessThanOrEqual(overlap.navTop + 1);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

for (const viewport of portraitMatrix) {
  test(`login is responsive at ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: MOBILE_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#loginForm')).toBeVisible({ timeout: 5000 });
    await auditResponsive(page, `login ${viewport.name}`);
    await context.close();
  });

  test(`admin home is responsive at ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: MOBILE_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    await prepareAuthenticatedPage(page, 'admin');
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await expectTitle(page, 'Автопарк');
    await auditResponsive(page, `admin home ${viewport.name}`, { bottomNav: viewport.width < 760 });
    if (viewport.width < 760) await assertBottomContentClearOfNav(page, `admin home ${viewport.name}`);
    await context.close();
  });
}

for (const viewport of [portraitMatrix[0], portraitMatrix[2], portraitMatrix[4]]) {
  test(`admin core flow is responsive at ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: MOBILE_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    await prepareAuthenticatedPage(page, 'admin');
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await expectTitle(page, 'Автопарк');

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="fleet"]').click();
    await expectTitle(page, 'Техника');
    await auditResponsive(page, `fleet ${viewport.name}`, { bottomNav: true });

    await page.locator('[data-action="add-vehicle"]').click();
    await expectTitle(page, 'Добавить технику');
    await auditResponsive(page, `vehicle form ${viewport.name}`, { bottomNav: true });
    await assertBottomContentClearOfNav(page, `vehicle form ${viewport.name}`);

    await page.locator('.back-btn').click();
    await expectTitle(page, 'Техника');
    await page.locator('.bottom-nav [data-action="main-nav"][data-id="service"]').click();
    await expectTitle(page, 'ТО и ремонт');
    await auditResponsive(page, `service ${viewport.name}`, { bottomNav: true });

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="print"]').click();
    await expectTitle(page, 'Печать');
    await auditResponsive(page, `print center ${viewport.name}`, { bottomNav: true });

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="home"]').click();
    await expectTitle(page, 'Автопарк');
    await page.locator('[data-action="issue-waybill"]').first().click();
    await expectTitle(page, 'Выдать путевой лист');
    await auditResponsive(page, `issue waybill ${viewport.name}`, { bottomNav: true });
    await assertBottomContentClearOfNav(page, `issue waybill ${viewport.name}`);

    await context.close();
  });
}

for (const viewport of [portraitMatrix[0], portraitMatrix[1], portraitMatrix[3], portraitMatrix[4]]) {
  test(`driver work is responsive at ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      userAgent: MOBILE_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    await prepareAuthenticatedPage(page, 'driver');
    await page.goto(APP, { waitUntil: 'domcontentloaded' });
    await expectTitle(page, 'Моя машина');
    await auditResponsive(page, `driver work ${viewport.name}`, { bottomNav: true });
    await assertBottomContentClearOfNav(page, `driver work ${viewport.name}`);

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="history"]').click();
    await expectTitle(page, 'История');
    await auditResponsive(page, `driver history ${viewport.name}`, { bottomNav: true });

    await page.locator('.bottom-nav [data-action="main-nav"][data-id="work"]').click();
    await expectTitle(page, 'Моя машина');
    await page.locator('[data-action="driver-action"]').first().click();
    await expectTitle(page, 'Зафиксировать выезд');
    await auditResponsive(page, `driver action ${viewport.name}`, { bottomNav: true });
    await assertBottomContentClearOfNav(page, `driver action ${viewport.name}`);

    await context.close();
  });
}

test('landscape phone stays usable at 844x390', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    userAgent: MOBILE_UA,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2
  });
  const page = await context.newPage();
  await prepareAuthenticatedPage(page, 'admin');
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await expectTitle(page, 'Автопарк');
  await auditResponsive(page, 'admin landscape 844x390', { desktopNav: true });
  await context.close();
});
