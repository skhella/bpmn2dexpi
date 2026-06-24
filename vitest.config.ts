import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom provides DOMParser/querySelectorAll/Document APIs in Node.js
    // without the ERR_REQUIRE_ESM issue that vitest's bundled jsdom causes via
    // the @exodus/bytes → html-encoding-sniffer dependency chain.
    environment: 'happy-dom',
    // Several transformer/registry tests parse the full Process.xml schema
    // multiple times and the importer round-trips run ELK layout — these
    // routinely exceed the 5s default when the suite runs in parallel under
    // CI load. Give them generous headroom so slow-but-correct tests don't
    // flake on a timeout.
    testTimeout: 30000,
    hookTimeout: 30000,
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
