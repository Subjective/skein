import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(import.meta.dirname, 'src/shared'), '@core': resolve(import.meta.dirname, 'src/core'), '@': resolve(import.meta.dirname, 'src/renderer/src') } },
  // Many tests run real processes (git, tail, ssh). A slow shared CI runner can take seconds for what
  // takes milliseconds locally, so the limits are generous: they only matter when something hangs.
  test: { include: ['src/**/*.test.ts'], environment: 'node', testTimeout: 30_000, hookTimeout: 30_000 },
});
