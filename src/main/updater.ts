/**
 * Update checks.
 *
 * Nothing is installed without being asked. A video editor is often left open
 * for hours over an unsaved cut, and a silent restart would take the work with
 * it — so the app checks, says what it found, and waits.
 *
 * Builds are not code-signed yet. Windows still installs an unsigned update,
 * but SmartScreen warns, so the notice says as much rather than letting the
 * warning arrive unexplained.
 */

import { app } from 'electron'
import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

export interface UpdateState {
  /** Version running now. */
  current: string
  /** Version found on the release feed, when one is newer. */
  available: string | null
  downloaded: boolean
  checking: boolean
  /** Progress of a download in progress, 0..100. */
  percent: number
  error: string | null
  /** False in development and in an unpacked build, where there is nothing to update. */
  supported: boolean
}

let state: UpdateState = {
  current: app.getVersion(),
  available: null,
  downloaded: false,
  checking: false,
  percent: 0,
  error: null,
  supported: app.isPackaged,
}

type Listener = (state: UpdateState) => void
let notify: Listener = () => {}

export function initUpdater(listener: Listener): void {
  notify = listener
  if (!state.supported) return

  // Downloading is a deliberate step, and so is restarting: both are the
  // user's call, not the updater's.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    state = { ...state, available: info.version, checking: false, error: null }
    notify(state)
  })
  autoUpdater.on('update-not-available', () => {
    state = { ...state, available: null, checking: false, error: null }
    notify(state)
  })
  autoUpdater.on('download-progress', (progress) => {
    state = { ...state, percent: Math.round(progress.percent) }
    notify(state)
  })
  autoUpdater.on('update-downloaded', () => {
    state = { ...state, downloaded: true, percent: 100 }
    notify(state)
  })
  autoUpdater.on('error', (error) => {
    state = { ...state, checking: false, error: error.message }
    notify(state)
  })
}

export function updateState(): UpdateState {
  return state
}

export async function checkForUpdate(): Promise<UpdateState> {
  if (!state.supported) {
    return { ...state, error: 'Updates only apply to an installed build.' }
  }
  state = { ...state, checking: true, error: null }
  notify(state)
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    state = { ...state, checking: false, error: (error as Error).message }
    notify(state)
  }
  return state
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (!state.available) return { ...state, error: 'No update to download.' }
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    state = { ...state, error: (error as Error).message }
    notify(state)
  }
  return state
}

/** Quits and installs. The caller is responsible for saving first. */
export function installUpdate(): void {
  if (!state.downloaded) return
  autoUpdater.quitAndInstall(false, true)
}
