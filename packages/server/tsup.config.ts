import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    clean: true,
    target: 'node18',
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    target: 'node18',
    splitting: false,
  },
])
