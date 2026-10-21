import { defineConfig, devices } from '@playwright/test';

const E2E_DB = process.env.DATABASE_URL_E2E ?? 'mysql://root@127.0.0.1:3306/crm_e2e';
const API_PORT = 4300;
const WEB_PORT = 5300;

/** End-to-end flows against a freshly installed instance (generic blueprint). */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './e2e/global-setup.ts',
  webServer: [
    {
      command: `npm run dev -w @app/api`,
      cwd: '../..',
      port: API_PORT,
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: E2E_DB,
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
        APP_URL: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: false,
      env: { API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
