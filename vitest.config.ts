import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use jsdom so DOMParser / Document APIs work in tests
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/transformer/**'],
      exclude: ['src/transformer/__tests__/**'],
    },
  },
});
