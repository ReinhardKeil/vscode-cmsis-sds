import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: 'test/e2e',
    testMatch: '**/*.spec.ts',
    timeout: 15000,
    retries: 0,
    use: {
        headless: true,
        viewport: { width: 1024, height: 768 },
    },
    projects: [
        {
            name: 'chromium',
            use: { browserName: 'chromium' },
        },
    ],
});
