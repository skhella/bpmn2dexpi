import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // jsdom environment provides DOMParser/Document APIs needed by the transformer
    // @exodus/bytes is pinned to 1.15.0 in package.json overrides to prevent
    // the ERR_REQUIRE_ESM issue from newer ESM-only versions of that package
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
