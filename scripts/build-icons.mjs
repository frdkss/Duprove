import { readFile, writeFile } from 'node:fs/promises'
import { Resvg } from '@resvg/resvg-js'

const publicDirectory = new URL('../public/', import.meta.url)
const source = await readFile(new URL('logo.svg', publicDirectory), 'utf8')
if (!/<svg\b[^>]*\bviewBox=/.test(source)) throw new Error('logo.svg must have a viewBox')
const square = source.replace(/<svg\b[^>]*>/, tag => tag
  .replace(/\s(?:width|height)=["'][^"']*["']/g, '')
  .replace('<svg', '<svg width="1024" height="1024"'))
const render = size => new Resvg(square, { fitTo: { mode: 'width', value: size } }).render().asPng()
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map(render)

const directory = Buffer.alloc(6 + sizes.length * 16)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(sizes.length, 4)
let offset = directory.length
images.forEach((png, index) => {
  const entry = 6 + index * 16
  directory[entry] = sizes[index] % 256
  directory[entry + 1] = sizes[index] % 256
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(png.length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += png.length
})
await writeFile(new URL('logo.ico', publicDirectory), Buffer.concat([directory, ...images]))
await writeFile(new URL('logo.png', publicDirectory), render(1024))
console.log('Application icons generated from public/logo.svg')
