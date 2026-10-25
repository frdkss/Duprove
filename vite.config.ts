import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import screenshotsPlugin from './vite.screenshots.ts'

export default defineConfig({
  plugins: [react(), tailwindcss(), screenshotsPlugin()],
  base: '/',
  server: {
    port: 5173,
    strictPort: true,
  },
})
