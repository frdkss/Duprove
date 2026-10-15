import { build } from 'esbuild'
await build({entryPoints:['electron/main.ts','electron/preload.ts','electron/analysis-worker.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',outdir:'dist-electron',external:['electron']})
