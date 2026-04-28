import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js'],
    // Legacy node-driven tests (test_anonymize.js, test_csv.js) are excluded —
    // run via `npm run test:legacy` if needed.
    exclude: ['node_modules/**', 'tests/test_*.js'],
    testTimeout: 5000,
  },
});
