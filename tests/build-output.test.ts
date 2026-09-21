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
import { join } from 'node:path'

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
