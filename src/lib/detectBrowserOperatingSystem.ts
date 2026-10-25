import type { BrowserPlatform, OperatingSystem } from '../types/platform'
import detectOperatingSystem from './detectOperatingSystem'

function readGraphicsRenderer() {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl')
  if (!gl) return ''
  try {
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    return debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : ''
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

export default async function detectBrowserOperatingSystem(
  browser: BrowserPlatform,
): Promise<OperatingSystem> {
  const initial = detectOperatingSystem(browser)
  if (
    initial !== 'unknown' ||
    !/Mac/i.test(`${browser.userAgentData?.platform} ${browser.platform} ${browser.userAgent}`)
  )
    return initial

  try {
    const hints = await browser.userAgentData?.getHighEntropyValues?.(['architecture'])
    const detected = detectOperatingSystem(browser, hints?.architecture)
    if (detected !== 'unknown') return detected
  } catch {
    // Some browsers disable high-entropy hints; try the graphics renderer next.
  }

  try {
    return detectOperatingSystem(browser, '', readGraphicsRenderer())
  } catch {
    return 'unknown'
  }
}
