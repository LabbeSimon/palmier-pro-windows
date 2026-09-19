import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

import { activeTimeline, type MediaAsset, type Project } from '../core/model.js'
import * as ops from '../core/ops.js'
import { OpError, type Receipt } from '../core/ops.js'
import { FFmpegError, ffmpegVersion, generateThumbnail, probeAsset, renderAssetFrame, renderFrame, renderTimeline, type RenderHandle } from './media/ffmpeg.js'
import { buildMenu } from './menu.js'
import { MCPServer, DEFAULT_MCP_PORT } from './mcp/server.js'
import { basename } from 'node:path'
import { cacheDirFor, isProjectFolder, loadProject, ProjectStore, saveProject } from './project/store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  window?.webContents.send('project:changed', { project, receipt })
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
      title: 'Open a .palmier project folder',
      properties: ['openDirectory'],
      buttonLabel: 'Open project',
    })
    if (picked.canceled || !picked.filePaths[0]) return { ...snapshot(), message: 'Open cancelled' }
    target = picked.filePaths[0]
  }
  // Validated before loading so the refusal names the folder instead of leaking ENOENT.
  if (!(await isProjectFolder(target))) {
    throw new OpError(
      'not_a_project',
      `"${basename(target)}" is not a Palmier project. Choose a folder that contains project.json.`,
    )
  }
  const loaded = await loadProject(target)
  store.replace(loaded)
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

handle('ops:addClips', (args) => store.apply((p) => ops.addClips(p, args)))
handle('ops:removeClips', (args) => store.apply((p) => ops.removeClips(p, args)))
handle('ops:splitClips', (args) => store.apply((p) => ops.splitClips(p, args)))
handle('ops:moveClips', (args) => store.apply((p) => ops.moveClips(p, args)))
handle('ops:setClipProperties', (args) => store.apply((p) => ops.setClipProperties(p, args)))
handle('ops:addTexts', (args) => store.apply((p) => ops.addTexts(p, args)))
handle('ops:updateText', (args) => store.apply((p) => ops.updateText(p, args)))
handle('ops:addTrack', (args) => store.apply((p) => ops.addTrack(p, args)))
handle('ops:removeTrack', (args) => store.apply((p) => ops.removeTrack(p, args.trackId, args.timelineId)))
handle('ops:setTrackFlags', (args) => store.apply((p) => ops.setTrackFlags(p, args)))
handle('ops:addMarkers', (args) => store.apply((p) => ops.addMarkers(p, args)))
handle('ops:createTimeline', (args) => store.apply((p) => ops.createTimeline(p, args)))
handle('ops:setActiveTimeline', (args) => store.apply((p) => ops.setActiveTimeline(p, args.timelineId)))
handle('ops:setProjectSettings', (args) => store.apply((p) => ops.setProjectSettings(p, args)))
handle('ops:removeAssets', (args) => store.apply((p) => ops.removeAssets(p, args.assetIds)))
handle('ops:shiftClips', (args) => store.apply((p) => ops.shiftClips(p, args)))
handle('ops:setWorkZone', (args) => store.apply((p) => ops.setWorkZone(p, args)))
handle('ops:addEffect', (args) => store.apply((p) => ops.addEffect(p, args)))
handle('ops:removeEffect', (args) => store.apply((p) => ops.removeEffect(p, args)))
handle('ops:setEffectParams', (args) => store.apply((p) => ops.setEffectParams(p, args)))
handle('ops:reorderEffect', (args) => store.apply((p) => ops.reorderEffect(p, args)))
handle('ops:addTransition', (args) => store.apply((p) => ops.addTransition(p, args)))
handle('ops:removeTransition', (args) => store.apply((p) => ops.removeTransition(p, args)))

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
  const timeline = activeTimeline(project)
  const output = join(cacheDirFor(project.path), `preview-${timeline.id}-${frame}.png`)
  await renderFrame(project, timeline, frame, output)
  const data = await readFile(output)
  return `data:image/png;base64,${data.toString('base64')}`
})

handle('render:assetFrame', async (args: { assetId: string; seconds: number }) => {
  const asset = store.project.assets.find((a) => a.id === args.assetId)
  if (!asset) throw new OpError('not_found', `media asset ${args.assetId} is not in this project`)
  const output = join(cacheDirFor(store.project.path), `clip-${asset.id}-${Math.round(args.seconds * 1000)}.jpg`)
  await renderAssetFrame(asset, args.seconds, output)
  const data = await readFile(output)
  return `data:image/jpeg;base64,${data.toString('base64')}`
})

handle('render:export', async (args: { outputPath?: string; quality?: 'draft' | 'balanced' | 'high' }) => {
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

  const quality = args?.quality ?? 'balanced'
  const encoder = {
    draft: { crf: 28, preset: 'veryfast' as const },
    balanced: { crf: 20, preset: 'medium' as const },
    high: { crf: 16, preset: 'slow' as const },
  }[quality]

  const handleRender = renderTimeline(project, timeline, { outputPath, ...encoder }, (progress) => {
    window?.webContents.send('render:progress', progress)
  })
  activeExport = handleRender
  try {
    await handleRender.promise
    return { cancelled: false, outputPath }
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

  protocol.handle('font', (request) => {
    const name = basename(decodeURIComponent(new URL(request.url).hostname + new URL(request.url).pathname))
    for (const root of [packaged, dev]) {
      if (!root) continue
      const candidate = join(root, name)
      if (existsSync(candidate)) return net.fetch(pathToFileURL(candidate).toString())
    }
    return new Response('font not found', { status: 404 })
  })
}

app.whenReady().then(async () => {
  registerFontProtocol()
  createWindow()
  await startMCP()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  activeExport?.cancel()
  void mcp?.stop()
})
