/**
 * Where the agent's API key lives.
 *
 * Encrypted with the OS keystore when one is available — DPAPI on Windows, the
 * login keyring on Linux — and refused rather than written in clear when it is
 * not, because a plaintext key in the user profile is a real liability and the
 * user has no way of knowing it is there.
 */

import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface StoredSettings {
  model: string
  /** Base64 of the encrypted key, or absent when none has been set. */
  key?: string
  /** False when the key is on disk unencrypted, which this build never does. */
  encrypted?: boolean
}

export const MODELS = [
  // Short enough to read whole in a narrow dock.
  { id: 'claude-opus-5', label: 'Opus 5 · strongest' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 · balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 · fastest' },
] as const

export const DEFAULT_MODEL = 'claude-sonnet-5'

function settingsPath(): string {
  return join(app.getPath('userData'), 'agent.json')
}

export async function readSettings(): Promise<{ model: string; hasKey: boolean }> {
  try {
    const stored = JSON.parse(await readFile(settingsPath(), 'utf8')) as StoredSettings
    return { model: stored.model || DEFAULT_MODEL, hasKey: Boolean(stored.key) }
  } catch {
    return { model: DEFAULT_MODEL, hasKey: false }
  }
}

export async function readApiKey(): Promise<string> {
  try {
    const stored = JSON.parse(await readFile(settingsPath(), 'utf8')) as StoredSettings
    if (!stored.key) return ''
    return safeStorage.decryptString(Buffer.from(stored.key, 'base64'))
  } catch {
    return ''
  }
}

export async function writeSettings(update: { model?: string; apiKey?: string }): Promise<void> {
  let stored: StoredSettings = { model: DEFAULT_MODEL }
  try {
    stored = JSON.parse(await readFile(settingsPath(), 'utf8')) as StoredSettings
  } catch {
    // First run: the defaults above stand.
  }

  if (update.model) stored.model = update.model
  if (update.apiKey !== undefined) {
    if (update.apiKey === '') {
      delete stored.key
      delete stored.encrypted
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(
          'This system has no keystore available, so the API key cannot be stored safely. ' +
            'Unlock your login keyring and try again.',
        )
      }
      stored.key = safeStorage.encryptString(update.apiKey).toString('base64')
      stored.encrypted = true
    }
  }

  await writeFile(settingsPath(), JSON.stringify(stored, null, 2), { mode: 0o600 })
}
