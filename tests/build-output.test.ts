/**
 * The built main bundle.
 *
 * electron-vite splices a CommonJS shim into the ESM output at an offset
 * computed in UTF-8 bytes but applied as a string index, so any multi-byte
 * character earlier in the bundle pushes it off target. It landed inside a
 * template literal twice: once the build failed with an unterminated string,
 * and once it silently shipped a slab of JavaScript inside a message shown in
 * the status bar. A unit test cannot see either — only the built file can.
 */

import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { copyFile, readFile, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const exec = promisify(execFile)
const BUNDLE = join(process.cwd(), 'out', 'main', 'index.js')

async function built(): Promise<string | null> {
  try {
    await stat(BUNDLE)
  } catch {
    return null
  }
  return readFile(BUNDLE, 'utf8')
}

describe('built main bundle', () => {
  it('carries no injected CommonJS shim', async () => {
    const code = await built()
    if (code === null) return // Nothing built yet; `npm run build` covers this.
    expect(code).not.toContain('CommonJS Shims')
    expect(code).not.toContain('__cjs_mod__')
  })

  it('parses as a module, which a shim landing mid-string would break', async () => {
    const code = await built()
    if (code === null) return

    // node --check needs the extension to decide module vs script.
    const copy = join(tmpdir(), `palmier-bundle-${process.pid}.mjs`)
    await copyFile(BUNDLE, copy)
    try {
      await exec(process.execPath, ['--check', copy])
    } finally {
      await rm(copy, { force: true })
    }
  }, 60_000)

  it('keeps the status messages whole', async () => {
    const code = await built()
    if (code === null) return
    // The exact string the shim cut in half the first time.
    expect(code).toMatch(/message: `Created "\$\{created\.project\.name\}"/)
  })
})

describe('bundled FFmpeg', () => {
  /**
   * The lookup walks up from the module, so it has to work from `src/` during
   * development and from `out/` in the built bundle. When it missed, the app
   * fell back to whatever was on PATH: a different renderer than the tested
   * one, and on this machine one that draws a glyph for a newline.
   */
  it('resolves the binaries the app ships, not the ones on PATH', async () => {
    const { FFMPEG_PATH, FFPROBE_PATH } = await import('../src/main/media/ffmpeg.js')
    const resolved: [string, string][] = [
      ['ffmpeg', FFMPEG_PATH],
      ['ffprobe', FFPROBE_PATH],
    ]
    for (const [name, path] of resolved) {
      // A bare name means the lookup gave up and left it to the shell.
      expect(path, `${name} fell back to PATH`).not.toBe(name)
      expect(path).toContain(join('resources', 'ffmpeg'))
      await stat(path)
    }
  })

  it('finds them from the built bundle directory too', async () => {
    const platformDir = join('resources', 'ffmpeg', `${process.platform}-${process.arch}`, 'ffmpeg')
    let directory = join(process.cwd(), 'out', 'main')
    let found: string | null = null
    for (let up = 0; up < 5 && !found; up++) {
      const candidate = join(directory, platformDir)
      try {
        await stat(candidate)
        found = candidate
      } catch {
        directory = dirname(directory)
      }
    }
    expect(found).not.toBeNull()
  })
})
