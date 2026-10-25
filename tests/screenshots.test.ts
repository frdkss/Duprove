import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { discoverScreenshots } from '../vite.screenshots'

const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'duprove-screenshots-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('duprove-screenshots-')
    )
      throw new Error('Unexpected fixture directory')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Автоматический список скриншотов', () => {
  it('Выбирает только изображения и сортирует номера естественно', () => {
    const directory = fixture()
    for (const filename of ['10.png', '2.png', '1.png', '3.PNG', '4.webp', 'notes.txt']) {
      writeFileSync(join(directory, filename), '')
    }
    mkdirSync(join(directory, '5.png'))
    expect(discoverScreenshots(directory).map((image) => image.src)).toEqual([
      'screenshots/1.png',
      'screenshots/2.png',
      'screenshots/3.PNG',
      'screenshots/4.webp',
      'screenshots/10.png',
    ])
  })

  it('Подхватывает любое количество новых файлов и удаление без ручного списка', () => {
    const directory = fixture()
    expect(discoverScreenshots(directory)).toEqual([])
    writeFileSync(join(directory, '1.png'), '')
    expect(discoverScreenshots(directory)).toHaveLength(1)
    for (let index = 2; index <= 37; index += 1) writeFileSync(join(directory, `${index}.png`), '')
    expect(discoverScreenshots(directory)).toHaveLength(37)
    rmSync(join(directory, '1.png'))
    expect(discoverScreenshots(directory)[0].src).toBe('screenshots/2.png')
  })

  it('Кодирует пробелы и специальные символы в адресах', () => {
    const directory = fixture()
    writeFileSync(join(directory, 'screen #1.png'), '')
    expect(discoverScreenshots(directory)[0].src).toBe('screenshots/screen%20%231.png')
  })

  it('Отсутствующая папка даёт пустую галерею', () => {
    expect(discoverScreenshots(join(fixture(), 'missing'))).toEqual([])
  })
})
