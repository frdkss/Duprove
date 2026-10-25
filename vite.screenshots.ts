import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import type { Plugin } from 'vite'

const imagePattern = /\.(png|jpe?g|webp|avif|gif)$/i
const moduleId = 'virtual:screenshots'
const resolvedModuleId = `\0${moduleId}`
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })

export function discoverScreenshots(directory: string) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && imagePattern.test(entry.name))
    .sort((first, second) => collator.compare(first.name, second.name))
    .map((entry) => ({
      src: `screenshots/${encodeURIComponent(entry.name)}`,
      alt: `Скриншот Duprove — ${basename(entry.name, extname(entry.name))}`,
    }))
}

export default function screenshotsPlugin(): Plugin {
  let directory = ''
  return {
    name: 'screenshots-manifest',
    configResolved(config) {
      directory = resolve(config.publicDir, 'screenshots')
    },
    resolveId(id) {
      if (id === moduleId) return resolvedModuleId
    },
    load(id) {
      if (id !== resolvedModuleId) return
      return `export default ${JSON.stringify(discoverScreenshots(directory))}`
    },
    configureServer(server) {
      const refresh = (file: string) => {
        if (resolve(dirname(file)) !== directory || !imagePattern.test(file)) return
        const graph = server.environments.client.moduleGraph
        const module = graph.getModuleById(resolvedModuleId)
        if (module) graph.invalidateModule(module)
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.add(directory)
      server.watcher.on('add', refresh)
      server.watcher.on('unlink', refresh)
      server.httpServer?.once('close', () => {
        server.watcher.off('add', refresh)
        server.watcher.off('unlink', refresh)
      })
    },
  }
}
