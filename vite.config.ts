import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, createReadStream, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
const pdfRoot = path.resolve('node_modules/pdfjs-dist')
const directories = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
export default defineConfig({plugins:[react(), {
  name: 'local-pdf-resources',
  configureServer(server) {
    server.middlewares.use('/pdf-assets/', (request, response, next) => {
      const [directory, name] = (request.url ?? '').split('?')[0].replace(/^\//, '').split('/')
      if (!directories.includes(directory) || !/^[\w.-]+$/.test(name ?? '')) { next(); return }
      const file = path.join(pdfRoot, directory, name)
      if (!existsSync(file)) { next(); return }
      response.setHeader('Content-Type', 'application/octet-stream'); createReadStream(file).pipe(response)
    })
  },
  closeBundle() { mkdirSync('dist/pdf-assets', { recursive: true }); for (const directory of directories) cpSync(path.join(pdfRoot, directory), path.join('dist/pdf-assets', directory), { recursive: true }) },
}], base:'./', build:{target:'chrome140'}, server:{host:'127.0.0.1',port:5173,strictPort:true}})
