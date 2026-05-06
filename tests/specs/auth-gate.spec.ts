import { test, expect } from '@playwright/test';

/**
 * Smoke #2 — auth-gate работает.
 *
 * SuitesForAll — закрытое приложение. Незалогиненный пользователь
 * должен видеть экран авторизации (Google sign-in / email login),
 * а не главное приложение.
 *
 * Что проверяем:
 *   1. На главной без сессии видны элементы login (кнопка Google,
 *      или email-форма).
 *   2. Не виден контент админки (нет building-list, нет Add Building).
 *
 * Этот тест ловит регрессии типа «случайно убрал auth check, и теперь
 * любой видит данные» — потенциально PII-leak.
 */

test('unauthenticated user sees login screen, not admin UI', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Даём 3 секунды чтобы авторизация Firebase успела отработать
  // и редирект на login отрисовался.
  await page.waitForTimeout(3000);

  // Should see SOMETHING login-related: либо Google-кнопка, либо
  // email-форма, либо текст «Sign in». Берём первое что найдётся.
  const loginIndicators = [
    page.getByText(/sign in/i),
    page.getByText(/log in/i),
    page.getByRole('button', { name: /google/i }),
    page.locator('input[type="email"]'),
  ];

  let foundLogin = false;
  for (const indicator of loginIndicators) {
    if (await indicator.first().isVisible().catch(() => false)) {
      foundLogin = true;
      break;
    }
  }
  expect(foundLogin, 'expected to see a login UI element').toBe(true);

  // Не должно быть видно admin-контента. Конкретные элементы могут
  // меняться — проверяем общим текстом «Add Building» или «Tenants».
  const adminIndicators = [
    page.getByRole('button', { name: /add building/i }),
    page.getByRole('button', { name: /add tenant/i }),
  ];
  for (const indicator of adminIndicators) {
    expect(
      await indicator.first().isVisible().catch(() => false),
      'admin UI should not be visible without auth'
    ).toBe(false);
  }
});
