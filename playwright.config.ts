import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  // テストが e2e/app/Counter.tsx を書き換えるので直列に実行する
  workers: 1,
  use: { baseURL: 'http://localhost:5198' },
  webServer: {
    command: 'pnpm exec vite e2e/app --config vite.config.ts --port 5198 --strictPort',
    url: 'http://localhost:5198',
  },
})
