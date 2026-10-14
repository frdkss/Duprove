import { build } from 'esbuild'
await build({entryPoints:['contracts/validate.ts','contracts/consent.ts','electron/services/report-service.ts','electron/services/consent-service.ts','electron/services/analyzer-service.ts'],bundle:true,platform:'node',format:'cjs',outdir:'.verification/tests',outbase:'.'})
