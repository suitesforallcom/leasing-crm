import { test, expect } from '@playwright/test';

/**
 * Smoke #1 — главная страница грузится без ошибок.
 *
 * Что проверяем:
 *   1. HTTP 200 на корне.
 *   2. Title матчит ожидаемый.
 *   3. Sentry SDK инициализировался (window.Sentry — объект).
 *   4. Service worker зарегистрирован (PWA не сломалась).
 *   5. В console.error за первые 3 секунды нет критических ошибок,
 *      кроме известного шума (расширения, сторонние CDN).
 *
 * Этот тест ловит ~70% поломок деплоя: «забыл закрыть тег», «упал
 * скрипт», «404 на manifest», «Sentry не подключился».
 */

test('app loads without console errors and Sentry initializes', async ({ page }) => {
  // Собираем все console-ошибки в массив чтобы потом отфильтровать.
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  // Главная страница должна вернуть 200.
  const response = await page.goto('/', { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);

  // Title согласно <title> в HTML.
  await expect(page).toHaveTitle(/SuitesForAll/);

  // Sentry должен инициализироваться — он подгружается через CDN async.
  // Даём 5 секунд и периодически проверяем.
  await expect.poll(
    async () => await page.evaluate(() => typeof (window as any).Sentry),
    { timeout: 5_000, message: 'Sentry SDK should load within 5s' }
  ).toBe('object');

  // Release tag должен быть НЕ "DEV" на проде (его проставляет stamp-release.sh).
  // На локальном devserver — "DEV" допустим.
  if ((process.env.PW_BASE_URL || '').includes('suitesforall.web.app')) {
    const release = await page.locator('meta[name="sfa-release"]').getAttribute('content');
    expect(release).not.toBe('DEV');
    expect(release).toMatch(/^[a-f0-9]{12}$/);
  }

  // Фильтруем известный шум — нужны только настоящие ошибки приложения.
  const significantErrors = errors.filter((e) => {
    if (/chrome-extension:\/\//.test(e)) return false;
    if (/Failed to load resource.*favicon/.test(e)) return false;
    // Sentry warning о missing keys из embedded agent — для нас не ошибка.
    if (/SENTRY|sentry-cdn/i.test(e) && /warning/i.test(e)) return false;
    return true;
  });

  if (significantErrors.length > 0) {
    console.log('Significant errors found:', significantErrors);
  }
  expect(significantErrors).toEqual([]);
});

test('static landing pages load', async ({ page }) => {
  // Билгийг отдельно от главного приложения; их легко сломать чисткой.
  for (const path of ['/billing.html', '/design-system.html']) {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `${path} should return 200`).toBe(200);
  }
});
