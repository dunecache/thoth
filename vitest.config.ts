import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Only source trees hold tests. Build output is generated, and several
    // packages emit a second copy of the suite alongside their compiled
    // files, which made every test run twice and let a stale build fail
    // after the source had already been fixed.
    include: ['{apps,packages}/*/src/**/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-*/**'],
  },
});
