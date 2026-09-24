import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { activeTimeline, timelineTotalFrames, type MediaAsset, type Project } from '../core/model.js'
import * as ops from '../core/ops.js'
import { OpError, type Receipt } from '../core/ops.js'
import { FFmpegError, ffmpegVersion, generateThumbnail, probeAsset, renderTimeline, type RenderHandle } from './media/ffmpeg.js'
import { buildMenu } from './menu.js'
import { media, MediaHost } from './media/host.js'
import { exportSetup, type ExportQuality } from './media/export.js'
import { getPerformance, loadPerformance, setPerformance, PREVIEW_HEIGHTS, MAX_PARALLEL_JOBS, defaultParallelJobs, type PerformanceSettings } from './media/performance.js'
import { CACHE_CATEGORIES, type CacheCategory } from './media/cache.js'
import { CONFIDENT, syncByAudio, SyncError } from './media/sync.js'
import { bestEncoder, hardwareDecodeWorks } from './media/encoders.js'
import { cpus } from 'node:os'
import { checkForUpdate, downloadUpdate, initUpdater, installUpdate, updateState } from './updater.js'
import { MCPServer, DEFAULT_MCP_PORT } from './mcp/server.js'
import { TOOLS_BY_NAME } from './mcp/tools.js'
import { AgentSession, type AgentEvent } from './agent/session.js'
import { DEFAULT_MODEL, MODELS, readApiKey, readSettings, writeSettings } from './agent/settings.js'
import { basename } from 'node:path'
import { formatSrt, formatVtt, parseSubtitles } from '../core/subtitles.js'
import { framesToSeconds, secondsToFrames } from '../core/timecode.js'
import {
  cacheDirFor,
  createProjectIn,
  isProjectFolder,
  loadProject,
  ProjectStore,
  saveProject,
} from './project/store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Must run before `app.whenReady`. A `<video>` refuses a custom scheme that is
 * not registered as a stream, and a stylesheet refuses a font from one that is
 * not standard — both fail silently, which is why this is easy to miss.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
  { scheme: 'font', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

const store = new ProjectStore()
let mcp: MCPServer | null = null
let mcpStatus: { running: boolean; endpoint: string | null; error: string | null } = {
  running: false,
  endpoint: null,
  error: null,
}
let window: BrowserWindow | null = null
let activeExport: RenderHandle | null = null

// --- Window ---------------------------------------------------------------

function createWindow(): void {
  window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0e0e11',
    show: false,
    title: 'Palmier Win',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  Menu.setApplicationMenu(buildMenu(window))
  window.once('ready-to-show', () => window?.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) {
    void window.loadURL(devServer)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    window = null
  })
}

/**
 * Posters are generated here rather than in the import path, so media imported by
 * an agent over MCP gets a thumbnail exactly like media imported through the UI.
 * Best-effort: a failure must never affect the project.
 */
const thumbnailed = new Set<string>()

function ensureThumbnails(project: Project): void {
  for (const asset of project.assets) {
    if (asset.thumbnailPath || thumbnailed.has(asset.id)) continue
    thumbnailed.add(asset.id)
    void generateThumbnail(asset, cacheDirFor(project.path))
      .then((thumbnailPath) => {
        if (thumbnailPath) window?.webContents.send('media:thumbnail', { assetId: asset.id, thumbnailPath })
      })
      .catch(() => thumbnailed.delete(asset.id))
  }
}

store.on('changed', (project: Project, receipt: Receipt) => {
  window?.webContents.send('project:changed', { project, receipt, journal: store.journal })
  ensureThumbnails(project)
})

// --- IPC helpers ----------------------------------------------------------

type Ok<T> = { ok: true; value: T }
type Err = { ok: false; code: string; message: string; details?: string }

function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

/** Errors cross the IPC boundary as values; the renderer shows them instead of crashing. */
function toError(error: unknown): Err {
  if (error instanceof OpError) return { ok: false, code: error.code, message: error.message }
  if (error instanceof FFmpegError) {
    return { ok: false, code: 'ffmpeg_failed', message: error.message, details: error.stderr.split('\n').slice(-12).join('\n') }
  }
  return { ok: false, code: 'internal_error', message: (error as Error).message ?? String(error) }
}

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await fn(...args))
    } catch (error) {
      return toError(error)
    }
  })
}

const snapshot = () => ({
  project: store.project,
  dirty: store.isDirty,
  history: store.history,
  journal: store.journal,
  mcp: mcpStatus,
})

// --- Project --------------------------------------------------------------

handle('project:snapshot', () => snapshot())

/** Unsaved work is never discarded without asking; silence here looked like a dead button. */
async function confirmDiscard(action: string): Promise<boolean> {
  if (!store.isDirty) return true
  const { response } = await dialog.showMessageBox(window!, {
    type: 'warning',
    buttons: ['Cancel', `Discard and ${action}`],
    defaultId: 0,
    cancelId: 0,
    title: 'Unsaved changes',
    message: `"${store.project.name}" has unsaved changes.`,
    detail: `They will be lost if you ${action} without saving.`,
  })
  return response === 1
}

handle('project:new', async () => {
  if (!(await confirmDiscard('start a new project'))) {
    return { ...snapshot(), message: 'Kept the current project' }
  }
  store.replace(ops.emptyProject())
  return { ...snapshot(), message: 'Started a new project' }
})

handle('project:open', async (path?: string) => {
  let target = path
  if (!target) {
    if (!(await confirmDiscard('open another project'))) {
      return { ...snapshot(), message: 'Kept the current project' }
    }
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Open a project folder, or pick any folder to start one',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open',
    })
    if (picked.canceled || !picked.filePaths[0]) return { ...snapshot(), message: 'Open cancelled' }
    target = picked.filePaths[0]
  }
  // A folder without a project is not an error, it is a project waiting to be
  // made — the same thing Obsidian does when you point it at a plain folder.
  if (!(await isProjectFolder(target))) {
    const { response } = await dialog.showMessageBox(window!, {
      type: 'question',
      buttons: ['Cancel', 'Create a project here'],
      defaultId: 1,
      cancelId: 0,
      title: 'No project in this folder yet',
      message: `"${basename(target)}" has no project in it.`,
      detail:
        'Create one here? Any video, audio or image already in the folder will be imported into the bin. ' +
        'Nothing else in the folder is touched.',
    })
    if (response !== 1) return { ...snapshot(), message: 'Open cancelled' }

    const created = await createProjectIn(target, probeAsset)
    store.replace(created.project)
    store.markSaved(target)
    ensureThumbnails(created.project)

    // Files that could not be read are named: a card dump with one bad file
    // must not look like a clean import.
    const parts = [
      created.imported.length > 0
        ? `${created.imported.length} file(s) imported`
        : 'no media found to import',
    ]
    if (created.failures.length > 0) {
      parts.push(`${created.failures.length} could not be read: ${created.failures[0]}`)
    }
    return { ...snapshot(), message: `Created "${created.project.name}" — ${parts.join(' — ')}` }
  }

  const loaded = await loadProject(target)
  store.replace(loaded)
  ensureThumbnails(loaded)
  return { ...snapshot(), message: `Opened "${loaded.name}"` }
})

handle('project:save', async (saveAs?: boolean) => {
  let target = store.project.path
  if (!target || saveAs) {
    const picked = await dialog.showSaveDialog(window!, {
      title: 'Save project',
      defaultPath: `${store.project.name}.palmier`,
      buttonLabel: 'Save',
    })
    if (picked.canceled || !picked.filePath) return snapshot()
    target = picked.filePath
  }
  const saved = await saveProject(store.project, target)
  store.markSaved(saved.path!)
  return { ...snapshot(), message: `Saved to ${saved.path}` }
})

handle('project:undo', () => {
  store.undo()
  return snapshot()
})

handle('project:redo', () => {
  store.redo()
  return snapshot()
})

// --- Timeline mutations. The renderer never edits state directly. ----------

/**
 * Editing operations reachable from the UI, by name.
 *
 * A table rather than 29 separate registrations because the journal has to be
 * able to re-run any of them during a revert, which needs a name it can look up.
 */
const UI_OPS: Record<string, (project: Project, args: any) => ops.MutationResult> = {
  addClips: ops.addClips,
  removeClips: ops.removeClips,
  splitClips: ops.splitClips,
  moveClips: ops.moveClips,
  setClipProperties: ops.setClipProperties,
  addTexts: ops.addTexts,
  updateText: ops.updateText,
  addTrack: ops.addTrack,
  removeTrack: (p, a) => ops.removeTrack(p, a.trackId, a.timelineId),
  setTrackFlags: ops.setTrackFlags,
  addMarkers: ops.addMarkers,
  createTimeline: ops.createTimeline,
  setActiveTimeline: (p, a) => ops.setActiveTimeline(p, a.timelineId),
  setProjectSettings: ops.setProjectSettings,
  removeAssets: (p, a) => ops.removeAssets(p, a.assetIds),
  shiftClips: ops.shiftClips,
  setWorkZone: ops.setWorkZone,
  groupClips: ops.groupClips,
  ungroupClips: ops.ungroupClips,
  trimClip: ops.trimClip,
  setKeyframe: ops.setKeyframe,
  moveKeyframe: ops.moveKeyframe,
  removeKeyframe: ops.removeKeyframe,
  addEffect: ops.addEffect,
  removeEffect: ops.removeEffect,
  setEffectParams: ops.setEffectParams,
  setEffectCurve: ops.setEffectCurve,
  reorderEffect: ops.reorderEffect,
  addTransition: ops.addTransition,
  removeTransition: ops.removeTransition,
  addSubtitles: ops.addSubtitles,
  setAssetProxies: ops.setAssetProxies,
  createMulticam: ops.createMulticam,
  switchAngle: ops.switchAngle,
}

for (const [name, operation] of Object.entries(UI_OPS)) {
  handle(`ops:${name}`, (args) =>
    store.apply((p) => operation(p, args), { source: 'ui', name, args }),
  )
}

/**
 * Re-runs one recorded edit against a given project.
 *
 * A tool is replayed through its own handler on a throwaway store, so the replay
 * takes exactly the path the original call took — no second implementation of
 * what `add_clips` means that could drift from the first.
 */
async function replay(
  source: 'ui' | 'agent' | 'mcp',
  name: string,
  args: unknown,
  project: Project,
): Promise<ops.MutationResult> {
  if (source === 'ui') {
    const operation = UI_OPS[name]
    if (!operation) throw new OpError('not_found', `unknown operation "${name}"`)
    return operation(project, args)
  }

  const tool = TOOLS_BY_NAME.get(name)
  if (!tool) throw new OpError('not_found', `unknown tool "${name}"`)
  const scratch = new ProjectStore(project)
  let receipt: Receipt | null = null
  scratch.on('changed', (_project: Project, emitted: Receipt) => {
    receipt = emitted
  })
  await tool.handler((args ?? {}) as Record<string, any>, {
    store: scratch,
    defaultExportDir: app.getPath('videos'),
  })
  if (!receipt) {
    throw new OpError('refused', `"${name}" changed nothing when re-run`)
  }
  return { project: scratch.project, receipt }
}

store.setReplayer(replay)

// --- Agent ----------------------------------------------------------------

let agent: AgentSession | null = null

function agentSession(): AgentSession {
  if (!agent) {
    agent = new AgentSession(store, { store, defaultExportDir: app.getPath('videos') })
    agent.on('event', (event: AgentEvent) => window?.webContents.send('agent:event', event))
  }
  return agent
}

handle('agent:settings', async () => ({ ...(await readSettings()), models: MODELS }))
handle('agent:configure', async (update: { model?: string; apiKey?: string }) => {
  await writeSettings(update)
  return { ...(await readSettings()), models: MODELS }
})

handle('agent:send', async (prompt: string) => {
  const settings = await readSettings()
  const apiKey = await readApiKey()
  await agentSession().send(prompt, { apiKey, model: settings.model || DEFAULT_MODEL })
  return { done: true }
})

handle('agent:cancel', () => {
  agent?.cancel()
  return { cancelled: true }
})

handle('agent:clear', () => {
  agent?.clear()
  return { cleared: true }
})

// --- Updates --------------------------------------------------------------

handle('update:state', () => updateState())
handle('update:check', () => checkForUpdate())
handle('update:download', () => downloadUpdate())
handle('update:install', async () => {
  if (store.isDirty) {
    throw new OpError(
      'refused',
      'Save the project first: installing an update restarts the app and unsaved work would be lost.',
    )
  }
  installUpdate()
  return { installing: true }
})

// --- Multicam -------------------------------------------------------------

/** Measures offsets; applying them is a separate, undoable step. */
handle('multicam:sync', async (assetIds: string[]) => {
  const assets = assetIds.map((id) => {
    const found = store.project.assets.find((a) => a.id === id)
    if (!found) throw new OpError('not_found', `media asset ${id} is not in this project`)
    return found
  })
  try {
    const results = await syncByAudio(assets)
    return results.map((result) => ({
      ...result,
      name: assets.find((a) => a.id === result.assetId)!.name,
      confident: result.confidence >= CONFIDENT,
    }))
  } catch (error) {
    if (error instanceof SyncError) throw new OpError('refused', error.message)
    throw error
  }
})

// --- Proxies --------------------------------------------------------------

handle('proxies:state', () => media.proxyState(store.project))

handle('proxies:build', async () => {
  const { built, receipt } = await media.buildProxies(store, (args) =>
    store.apply((p) => ops.setAssetProxies(p, args), { source: 'ui', name: 'setAssetProxies', args }),
  )
  if (!receipt) return { built: 0, message: 'Every clip already had a current proxy' }
  return { built, message: receipt.summary }
})

handle('proxies:cancel', () => ({ cancelled: media.cancelProxies() }))

/** Drops the proxy paths so the editor reads originals again. Files stay cached. */
handle('proxies:clear', () => {
  const proxied = store.project.assets.filter((asset) => asset.proxyPath)
  if (proxied.length === 0) return { message: 'No clip is using a proxy' }
  const args = { proxies: proxied.map((asset) => ({ assetId: asset.id, proxyPath: null })) }
  const receipt = store.apply((p) => ops.setAssetProxies(p, args), {
    source: 'ui',
    name: 'setAssetProxies',
    args,
  })
  return { message: `${proxied.length} clip(s) back on their originals — ${receipt.summary}` }
})

// --- Subtitles ------------------------------------------------------------

handle('subtitles:import', async (path?: string) => {
  let target = path
  if (!target) {
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Import subtitles',
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }],
      properties: ['openFile'],
    })
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true }
    target = picked.filePaths[0]
  }

  const source = await readFile(target, 'utf8')
  const { cues, skipped } = parseSubtitles(source)
  if (cues.length === 0) {
    throw new OpError(
      'refused',
      `"${basename(target)}" contains no usable cue` +
        (skipped.length > 0 ? ` — ${skipped[0]}` : ''),
    )
  }

  const timeline = activeTimeline(store.project)
  const args = {
    timelineId: timeline.id,
    subtitles: cues.map((cue) => ({
      startFrame: Math.max(0, secondsToFrames(cue.startSeconds, timeline.fps)),
      durationFrames: Math.max(1, secondsToFrames(cue.endSeconds - cue.startSeconds, timeline.fps)),
      text: cue.text,
    })),
  }
  const receipt = store.apply((p) => ops.addSubtitles(p, args), {
    source: 'ui',
    name: 'addSubtitles',
    args,
  })
  return { cancelled: false, receipt, unusableLines: skipped }
})

handle('subtitles:export', async () => {
  const timeline = activeTimeline(store.project)
  const cues = ops.subtitleCues(timeline).map(({ clip }) => ({
    startSeconds: framesToSeconds(clip.startFrame, timeline.fps),
    endSeconds: framesToSeconds(clip.startFrame + clip.durationFrames, timeline.fps),
    text: clip.textContent ?? '',
  }))
  if (cues.length === 0) {
    throw new OpError('refused', `"${timeline.name}" has no subtitle cue to write`)
  }

  const picked = await dialog.showSaveDialog(window!, {
    title: 'Export subtitles',
    defaultPath: `${timeline.name}.srt`,
    filters: [
      { name: 'SubRip', extensions: ['srt'] },
      { name: 'WebVTT', extensions: ['vtt'] },
    ],
  })
  if (picked.canceled || !picked.filePath) return { cancelled: true }

  const vtt = picked.filePath.toLowerCase().endsWith('.vtt')
  await writeFile(picked.filePath, vtt ? formatVtt(cues) : formatSrt(cues), 'utf8')
  return { cancelled: false, path: picked.filePath, cues: cues.length, message: `Wrote ${cues.length} cue(s) to ${picked.filePath}` }
})

handle('journal:list', () => store.journal)
handle('journal:revert', async (entryId: string) => {
  const receipt = await store.revertEntry(entryId)
  return { receipt, journal: store.journal }
})

// --- Media ----------------------------------------------------------------

handle('media:import', async (paths?: string[]) => {
  let targets = paths
  if (!targets?.length) {
    const picked = await dialog.showOpenDialog(window!, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'wmv', 'm4v', 'mp3', 'wav', 'aac', 'm4a', 'flac', 'png', 'jpg', 'jpeg', 'webp', 'bmp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (picked.canceled) return { changed: false, summary: 'Import cancelled', affectedIds: [], warnings: [] }
    targets = picked.filePaths
  }

  const assets: MediaAsset[] = []
  const failures: string[] = []
  for (const path of targets) {
    try {
      assets.push(await probeAsset(path))
    } catch (error) {
      failures.push(`${path}: ${(error as Error).message}`)
    }
  }
  if (assets.length === 0) throw new OpError('refused', `nothing could be imported — ${failures.join('; ')}`)

  const receipt = store.apply((p) => ops.addAssets(p, assets))
  return { ...receipt, warnings: [...receipt.warnings, ...failures] }
})

handle('media:readImage', async (path: string) => {
  const data = await readFile(path)
  return `data:image/jpeg;base64,${data.toString('base64')}`
})

// --- Rendering ------------------------------------------------------------

handle('render:frame', async (frame: number) => {
  const project = store.project
  const { path } = await media.timelineFrame(project, activeTimeline(project), frame)
  const data = await readFile(path)
  return `data:image/jpeg;base64,${data.toString('base64')}`
})

handle('render:assetFrame', async (args: { assetId: string; seconds: number }) => {
  const { path } = await media.assetFrame(store.project, args.assetId, args.seconds)
  const data = await readFile(path)
  return `data:image/jpeg;base64,${data.toString('base64')}`
})

/** Current proxy state, so the UI knows whether playback is possible and fresh. */
handle('preview:state', () => {
  const project = store.project
  return media.previewState(project, activeTimeline(project))
})

handle('preview:render', async () => {
  const project = store.project
  const state = await media.renderPreview(project, activeTimeline(project))
  return MediaHost.info(state)
})

handle('preview:cancel', () => ({ cancelled: media.cancelPreview() }))

handle('render:export', async (args: {
  outputPath?: string
  quality?: 'draft' | 'balanced' | 'high'
  hardware?: boolean
}) => {
  if (activeExport) throw new OpError('refused', 'an export is already running; cancel it first')

  const project = store.project
  const timeline = activeTimeline(project)
  let outputPath = args?.outputPath
  if (!outputPath) {
    const picked = await dialog.showSaveDialog(window!, {
      title: 'Export video',
      defaultPath: `${timeline.name}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    })
    if (picked.canceled || !picked.filePath) return { cancelled: true }
    outputPath = picked.filePath
  }

  const setup = await exportSetup((args?.quality ?? 'balanced') as ExportQuality, args?.hardware !== false)
  const handleRender = renderTimeline(
    project,
    timeline,
    { outputPath, ...setup.options },
    (progress) => window?.webContents.send('render:progress', progress),
  )
  activeExport = handleRender
  try {
    await media.trackExport(handleRender.promise)
    return { cancelled: false, outputPath, encoder: setup.encoder.label }
  } finally {
    activeExport = null
  }
})

handle('render:cancel', () => {
  if (!activeExport) return { cancelled: false }
  activeExport.cancel()
  return { cancelled: true }
})

handle('clipboard:write', (text: string) => {
  clipboard.writeText(text)
  return true
})

handle('shell:reveal', (path: string) => {
  shell.showItemInFolder(path)
  return true
})

handle('system:encoder', async () => {
  const encoder = await bestEncoder()
  return { name: encoder.name, label: encoder.label, hardware: encoder.hardware }
})

// --- Performance and cache -------------------------------------------------

async function performanceSnapshot() {
  const encoder = await bestEncoder()
  return {
    settings: getPerformance(),
    options: { previewHeights: PREVIEW_HEIGHTS, maxParallelJobs: MAX_PARALLEL_JOBS },
    machine: {
      logicalCores: cpus().length,
      recommendedParallelJobs: defaultParallelJobs(),
      encoder: encoder.label,
      hardwareEncoder: encoder.hardware,
      hardwareDecodeAvailable: await hardwareDecodeWorks(),
    },
    cache: await media.usage(store.project),
  }
}

handle('performance:get', () => performanceSnapshot())

handle('performance:set', async (update: Partial<PerformanceSettings>) => {
  if (update.hardwareDecode && !(await hardwareDecodeWorks())) {
    throw new OpError('refused', 'No hardware decoder works on this machine, so it stays off.')
  }
  await setPerformance(update)
  media.editHappened()
  return performanceSnapshot()
})

handle('cache:clear', async (categories: CacheCategory[]) => {
  const wanted = categories.filter((c) => CACHE_CATEGORIES.includes(c))
  if (wanted.length === 0) throw new OpError('invalid_argument', 'choose at least one kind of cached data')
  const result = await media.clearCache(store, wanted, (args) =>
    store.apply((p) => ops.setAssetProxies(p, args), { source: 'ui', name: 'setAssetProxies', args }),
  )
  return { ...(await performanceSnapshot()), freed: { files: result.files, bytes: result.bytes } }
})

handle('system:info', async () => ({
  ffmpeg: await ffmpegVersion().catch((error: Error) => `unavailable — ${error.message}`),
  electron: process.versions.electron,
  node: process.versions.node,
  mcp: mcpStatus,
}))

// --- Lifecycle ------------------------------------------------------------

async function startMCP(): Promise<void> {
  const port = Number(process.env.PALMIER_MCP_PORT ?? DEFAULT_MCP_PORT)
  const server = new MCPServer({ store, defaultExportDir: app.getPath('videos') }, port)
  try {
    await server.start()
    mcp = server
    mcpStatus = { running: true, endpoint: server.endpoint, error: null }
  } catch (error) {
    // A busy port must not stop the editor from opening.
    mcpStatus = { running: false, endpoint: null, error: (error as Error).message }
  }
  window?.webContents.send('mcp:status', mcpStatus)
}

/**
 * Fonts live outside the asar (they are extraResources) and the renderer cannot
 * read arbitrary file:// URLs under contextIsolation. A tiny scheme keeps the
 * stylesheet identical in dev and in the packaged app.
 */
function registerFontProtocol(): void {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resourcesPath ? join(resourcesPath, 'fonts') : null
  const dev = join(__dirname, '../../resources/fonts')

  // Preview proxies live in the project cache; the player reads them here.
  // The file name goes in the PATH, never the host: a standard scheme lowercases
  // its host, which silently breaks any name with capitals.
  protocol.handle('preview', (request) => {
    const name = basename(decodeURIComponent(new URL(request.url).pathname))
    if (!name) return new Response('no preview named', { status: 400 })
    const candidate = join(cacheDirFor(store.project.path), name)
    if (!existsSync(candidate)) return new Response(`preview ${name} not found`, { status: 404 })
    return net.fetch(pathToFileURL(candidate).toString())
  })

  protocol.handle('font', (request) => {
    const name = basename(decodeURIComponent(new URL(request.url).pathname))
    for (const root of [packaged, dev]) {
      if (!root) continue
      const candidate = join(root, name)
      if (existsSync(candidate)) return net.fetch(pathToFileURL(candidate).toString())
    }
    return new Response(`font ${name} not found`, { status: 404 })
  })
}

app.whenReady().then(async () => {
  await loadPerformance(join(app.getPath('userData'), 'performance.json'))
  media.attach(store)
  media.on('preview:progress', (progress) => window?.webContents.send('preview:progress', progress))
  media.on('preview:done', () => window?.webContents.send('preview:done'))
  media.on('proxies:progress', (progress) => window?.webContents.send('proxies:progress', progress))
  media.on('proxies:done', () => window?.webContents.send('proxies:done'))
  registerFontProtocol()
  createWindow()
  initUpdater((update) => window?.webContents.send('update:state', update))
  await startMCP()

  // One quiet check at startup. Nothing downloads or installs without being
  // asked; this only fills in the notice in the status bar.
  setTimeout(() => void checkForUpdate(), 4000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  activeExport?.cancel()
  media.cancelPreview()
  media.cancelProxies()
  void mcp?.stop()
})
