import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom provides DOMParser/querySelectorAll/Document APIs in Node.js
    // without the ERR_REQUIRE_ESM issue that vitest's bundled jsdom causes via
    // the @exodus/bytes → html-encoding-sniffer dependency chain.
    environment: 'happy-dom',
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
