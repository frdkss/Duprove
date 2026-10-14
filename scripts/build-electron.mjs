import { build } from 'esbuild'
await build({entryPoints:['electron/main.ts','electron/preload.ts'],bundle:true,platform:'node',format:'cjs',target:'node16',outdir:'dist-electron',external:['electron']})
