import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/opentmux': 'src/bin/opentmux.ts',
  },
  format: ['esm'],
  dts: {
    entry: ['src/index.ts']
  },
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  target: 'esnext',
  outDir: 'dist',
  shims: true
});
