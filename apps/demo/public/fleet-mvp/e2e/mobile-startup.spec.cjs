const { test, expect } = require('@playwright/test');

const APP = 'http://127.0.0.1:4173/fleet-mvp/';
const SUPABASE = 'https://tikjmiyrhkcjrxjylmqb.supabase.co';

test.use({
  viewport: { width: 360, height: 800 },
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36'
});

test('authenticated Android startup paints the base screen before admin bundle hydration', async ({ page }) => {
  let adminHomeResolved = false;
  const prematureRoleRequests = [];

  await page.addInitScript(() => {
    localStorage.setItem('fleet_mvp_session_v2', JSON.stringify({
      access_token: 'e2e-access-token',
      refresh_token: 'e2e-refresh-token',
      expires_at: 4102444800,
      user: { id: 'e2e-admin', email: 'e2e-admin@example.test' }
    }));
  });

  page.on('request', request => {
    const url = request.url();
    if (url.includes('/fleet-mvp/ux-session-boundary-v1.js') && !adminHomeResolved) {
      prematureRoleRequests.push(url);
    }
  });

  await page.route(`${SUPABASE}/**`, async route => {
    const url = new URL(route.request().url());

    if (url.pathname.endsWith('/rest/v1/rpc/get_app_shell')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          role: 'admin',
          navigation: [
            { id: 'home', label: 'Главная' },
            { id: 'fleet', label: 'Техника' },
            { id: 'service', label: 'ТО и ремонт' },
            { id: 'print', label: 'Печать' }
          ]
        })
      });
    }

    if (url.pathname.endsWith('/rest/v1/rpc/get_admin_home')) {
      await new Promise(resolve => setTimeout(resolve, 900));
      adminHomeResolved = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          headline: 'Автопарк',
          fleet: { total: 5, operational: 4, repair: 1, unavailable: 0 },
          waybills: { active: 1, waiting_review: 0, needs_correction: 0 },
          incidents: {},
          attention: [],
          attention_total: 0
        })
      });
    }

    if (url.pathname.endsWith('/rest/v1/rpc/get_fleet_list_ui') ||
        url.pathname.endsWith('/rest/v1/rpc/get_drivers_list_ui') ||
        url.pathname.endsWith('/rest/v1/rpc/get_waybills_list_ui')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    }

    if (url.pathname.includes('/rest/v1/rpc/')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }

    if (url.pathname.endsWith('/rest/v1/notifications')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });

  await expect(page.locator('.main .page-title')).toContainText('Автопарк', { timeout: 5000 });
  await expect(page.locator('.main .inline-loading')).toHaveCount(0);
  expect(prematureRoleRequests, 'role-specific modules must not hydrate while the base RPC screen is still loading').toEqual([]);

  await expect.poll(async () => page.locator('script[src*="ux-role-loader-v1.js"]').count()).toBe(1);
});
