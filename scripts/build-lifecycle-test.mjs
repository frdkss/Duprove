import { build } from 'esbuild'
import path from 'node:path'
import { copyFile, mkdir, cp } from 'node:fs/promises'
await build({ entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', format: 'cjs', define: { __DUPROVE_UPDATE_KEY__: '""' },
  outfile: '.verification/lifecycle/main.js', plugins: [{ name: 'synthetic-jobs', setup(builder) {
    builder.onResolve({ filter: /^\.\/services\/job-client$/ }, () => ({ path: path.resolve('tests/lifecycle-job-client.ts') }))
    builder.onResolve({ filter: /^electron$/ }, args => args.importer.endsWith('lifecycle-electron.ts')
      ? { path: 'electron', external: true } : { path: path.resolve('tests/lifecycle-electron.ts') })
  } }] })
await copyFile('dist-electron/preload.js', '.verification/lifecycle/preload.js')
await mkdir('.verification/dist', { recursive: true })
await cp('dist', '.verification/dist', { recursive: true })
