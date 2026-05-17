import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for SuitesForAll smoke tests.
 *
 * Назначение:
 *   - Быстрая проверка прода после deploy: страница грузится, нет console.error,
 *     Sentry инициализируется, статические ассеты доступны.
 *   - Локальная проверка перед коммитом (`npm test`).
 *   - CI на GitHub Actions для каждого push в feature/* и main.
 *
 * Базовый URL по умолчанию — production. Для локальной разработки можно
 * переопределить: PW_BASE_URL=http://localhost:5577 npm test.
 *
 * Создан 2026-05-06.
 */
export default defineConfig({
  testDir: './specs',
  // Все три файла specs/* изолированы — параллелим без проблем.
  fullyParallel: true,
  // На CI ошибка теста = красный билд; локально просто выводим report.
  forbidOnly: !!process.env.CI,
  // Retry только на CI: локально хочется видеть flake-ы как есть.
  retries: process.env.CI ? 1 : 0,
  // Один worker на CI (чтобы Sentry-события не путались между тестами);
  // локально пусть Playwright сам решает.
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PW_BASE_URL || 'https://suitesforall.web.app',
    // Скриншот при падении — для быстрой диагностики в CI artifacts.
    screenshot: 'only-on-failure',
    // Trace на первой повторной попытке — экономит место в репорте.
    trace: 'on-first-retry',
    // Realistic viewport (desktop). Mobile-тесты дописываем позже отдельным project.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Firefox/WebKit добавляем когда соберём базовый набор и убедимся что
    // smoke-набор стабилен в Chromium. Иначе мaintenance-стоимость x3.
  ],
});
