import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/main.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
});
