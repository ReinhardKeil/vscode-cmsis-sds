import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        globals: true,
        testTimeout: 10000,
        reporters: process.env.CI
            ? ['default', 'junit']
            : ['default'],
        outputFile: process.env.CI
            ? { junit: 'test-results/vitest-report.xml' }
            : undefined,
    },
});
