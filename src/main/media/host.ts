/**
 * The one owner of background media work: the timeline preview, proxies,
 * monitor frames and the cache.
 *
 * The UI and the MCP tools both drive this. Before it, each kept its own
 * version — the tool built proxies one at a time at normal priority while the
 * dialog did something else, and an agent could not ask for a preview at all.
 * Now "build the preview" means one thing whoever asks, and two callers cannot
 * start two renders of the same edit side by side.
 */

import { EventEmitter } from 'node:events'
import { basename } from 'node:path'

import { timelineTotalFrames, type Project, type Timeline } from '../../core/model.js'
import { OpError, type Receipt } from '../../core/ops.js'
import type { ProjectStore } from '../project/store.js'

/** Arguments of the one edit media work makes: pointing clips at proxies. */
export interface ProxyPathsArgs {
  proxies: { assetId: string; proxyPath: string | null }[]
}

/**
 * Records that edit. The caller applies it, so it is attributed and journaled
 * the way its own edits are — and a UI revert can replay it from `args`.
 */
export type RecordProxyPaths = (args: ProxyPathsArgs) => Receipt
import { cacheDirFor } from '../project/store.js'
import {
  cacheUsage,
  clearCache,
  enforceCacheLimit,
  type CacheCategory,
  type CacheUsage,
} from './cache.js'
import type { RenderProgress } from './ffmpeg.js'
import { assetFrame, timelineFrame, type CachedFrame } from './frames.js'
import { getPerformance } from './performance.js'
import {
  existingPreview,
  fingerprintTimeline,
  previewSetup,
  renderPreview,
  type PreviewJob,
  type PreviewState,
} from './preview.js'
import { buildProxies, canProxy, existingProxy, PROXY_WIDTH, type ProxyJob, type ProxyProgress } from './proxy.js'

/** Pause in editing before a background preview starts. */
export const AUTO_PREVIEW_DELAY_MS = 2500

/** Monitor frames rendered between two checks of the cache ceiling. */
const FRAMES_PER_CACHE_CHECK = 40

export interface PreviewInfo {
  fingerprint: string
  ready: boolean
  rendering: boolean
  /** True when the running render was started by the idle scheduler. */
  background: boolean
  url?: string
  startFrame?: number
  totalFrames?: number
  fps?: number
  width?: number
  height?: number
  encoder?: string
}

export function previewUrl(state: PreviewState): string {
  return `preview://local/${basename(state.path)}`
}

function infoFor(state: PreviewState, rendering: boolean, background: boolean): PreviewInfo {
  return {
    fingerprint: state.fingerprint,
    ready: true,
    rendering,
    background,
    url: previewUrl(state),
    startFrame: state.startFrame,
    totalFrames: state.totalFrames,
    fps: state.fps,
    width: state.width,
    height: state.height,
    encoder: state.encoder,
  }
}

interface RunningPreview {
  cancel: () => void
  background: boolean
  /** Resolves once the render is over, whatever its outcome. */
  settled: Promise<void>
}

export class MediaHost extends EventEmitter {
  private preview: RunningPreview | null = null
  private proxies: ProxyJob | null = null
  private frame: AbortController | null = null
  private framesSinceCheck = 0
  private autoTimer: ReturnType<typeof setTimeout> | null = null
  private exports = 0
  private store: ProjectStore | null = null

  /** Wires the idle scheduler to a store. Called once by the app. */
  attach(store: ProjectStore): void {
    this.store = store
    store.on('changed', () => this.editHappened())
  }

  get previewRunning(): boolean {
    return this.preview !== null
  }

  // --- Preview -------------------------------------------------------------

  async previewState(project: Project, timeline: Timeline): Promise<PreviewInfo> {
    const setup = await previewSetup()
    const cacheDir = cacheDirFor(project.path)
    const existing = existingPreview(project, timeline, cacheDir, setup)
    const rendering = this.preview !== null
    const background = this.preview?.background ?? false
    if (existing) return infoFor(existing, rendering, background)
    return {
      fingerprint: fingerprintTimeline(project, timeline, setup),
      ready: false,
      rendering,
      background,
    }
  }

  /**
   * Builds the preview of the current edit.
   *
   * A request from a person or an agent takes over from a background render:
   * that one is cancelled, its finished slices stay cached, and the new render
   * picks them up — nothing already encoded is paid for twice.
   */
  async renderPreview(
    project: Project,
    timeline: Timeline,
    options: { background?: boolean } = {},
  ): Promise<PreviewState> {
    if (timelineTotalFrames(timeline) === 0) {
      throw new OpError('refused', 'the timeline is empty; there is nothing to preview')
    }
    while (this.preview) {
      if (!this.preview.background || options.background) {
        throw new OpError('refused', 'a preview render is already running')
      }
      const yielding = this.preview
      yielding.cancel()
      await yielding.settled
    }

    /*
     * The slot is taken before the first await. Checking and then awaiting the
     * setup let two callers both see an empty slot and start two renders of
     * the same edit, writing the same files.
     */
    let job: PreviewJob | null = null
    let cancelled = false
    let finish!: () => void
    const running: RunningPreview = {
      background: Boolean(options.background),
      cancel: () => {
        cancelled = true
        job?.cancel()
      },
      settled: new Promise<void>((resolve) => (finish = resolve)),
    }
    this.preview = running
    try {
      const setup = await previewSetup()
      if (cancelled) throw new OpError('cancelled', 'the preview render was cancelled')
      // A background render always yields: it runs below normal priority even
      // when the setting says otherwise, because nobody asked for it.
      job = renderPreview(
        project,
        timeline,
        cacheDirFor(project.path),
        (progress: RenderProgress) => this.emit('preview:progress', progress),
        { ...setup, background: setup.background || running.background },
      )
      return await job.promise
    } finally {
      if (this.preview === running) this.preview = null
      finish()
      this.emit('preview:done')
    }
  }

  cancelPreview(): boolean {
    if (!this.preview) return false
    this.preview.cancel()
    return true
  }

  /** Any preview info a caller wants after a render: the same shape as a state. */
  static info(state: PreviewState): PreviewInfo {
    return infoFor(state, false, false)
  }

  // --- Idle preview --------------------------------------------------------

  /** Exports running now; background previews wait for them. */
  async trackExport<T>(work: Promise<T>): Promise<T> {
    this.exports++
    this.cancelBackground()
    try {
      return await work
    } finally {
      this.exports--
    }
  }

  private cancelBackground(): void {
    if (this.preview?.background) this.preview.cancel()
  }

  /**
   * An edit dropped the current background render and restarts the countdown.
   *
   * Cancelling costs little: slices are cached one by one, so whatever the
   * cancelled render finished is reused by the next one. Only the slice that
   * was in flight is lost.
   */
  editHappened(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer)
    this.autoTimer = null
    if (!getPerformance().autoPreview) return
    this.cancelBackground()
    this.autoTimer = setTimeout(() => void this.autoRun(), AUTO_PREVIEW_DELAY_MS)
  }

  private async autoRun(): Promise<void> {
    this.autoTimer = null
    const store = this.store
    if (!store || !getPerformance().autoPreview) return
    // Someone is waiting for a render or an export: stay out of the way and
    // look again after the next pause.
    if (this.preview || this.exports > 0) {
      this.autoTimer = setTimeout(() => void this.autoRun(), AUTO_PREVIEW_DELAY_MS)
      return
    }
    const project = store.project
    const timeline = project.timelines.find((t) => t.id === project.activeTimelineId)
    if (!timeline || timelineTotalFrames(timeline) === 0) return
    try {
      await this.renderPreview(project, timeline, { background: true })
    } catch {
      // Cancelled by the next edit, most likely. A real failure shows up when
      // the preview is asked for, with its diagnostics, rather than as a
      // message about something nobody requested.
    }
  }

  // --- Monitor frames ------------------------------------------------------

  /**
   * A composited frame for the monitor.
   *
   * A newer request drops the one still rendering: while scrubbing only the
   * frame under the playhead matters, and letting a queue of stale renders
   * finish first is what makes a monitor feel like it is lagging behind.
   */
  async timelineFrame(project: Project, timeline: Timeline, frame: number): Promise<CachedFrame> {
    this.frame?.abort()
    const controller = new AbortController()
    this.frame = controller
    const cacheDir = cacheDirFor(project.path)
    try {
      const result = await timelineFrame(project, timeline, frame, cacheDir, controller.signal)
      if (!result.hit) this.countFrame(cacheDir)
      return result
    } catch (error) {
      if (controller.signal.aborted) throw new OpError('superseded', 'a newer frame was requested')
      throw error
    } finally {
      if (this.frame === controller) this.frame = null
    }
  }

  async assetFrame(project: Project, assetId: string, seconds: number): Promise<CachedFrame> {
    const asset = project.assets.find((a) => a.id === assetId)
    if (!asset) throw new OpError('not_found', `media asset ${assetId} is not in this project`)
    const cacheDir = cacheDirFor(project.path)
    const result = await assetFrame(asset, seconds, cacheDir)
    if (!result.hit) this.countFrame(cacheDir)
    return result
  }

  private countFrame(cacheDir: string): void {
    if (++this.framesSinceCheck < FRAMES_PER_CACHE_CHECK) return
    this.framesSinceCheck = 0
    void enforceCacheLimit(cacheDir, getPerformance().cacheLimitGB * 1024 ** 3).catch(() => {})
  }

  // --- Proxies -------------------------------------------------------------

  get proxiesBuilding(): boolean {
    return this.proxies !== null
  }

  async proxyState(project: Project): Promise<{ total: number; ready: number; building: boolean; width: number }> {
    const cacheDir = cacheDirFor(project.path)
    const videos = project.assets.filter(canProxy)
    const withProxy = await Promise.all(videos.map((asset) => existingProxy(asset, cacheDir)))
    return {
      total: videos.length,
      ready: withProxy.filter(Boolean).length,
      building: this.proxies !== null,
      width: PROXY_WIDTH,
    }
  }

  /**
   * Transcodes every video clip that has no current proxy, then records the
   * paths in one undoable operation.
   */
  async buildProxies(
    store: ProjectStore,
    record: RecordProxyPaths,
  ): Promise<{ built: number; receipt: Receipt | null }> {
    if (this.proxies) throw new OpError('refused', 'proxies are already being built')
    const project = store.project
    const assets = project.assets.filter(canProxy)
    if (assets.length === 0) throw new OpError('refused', 'this project has no video clip to proxy')

    const settings = getPerformance()
    const job = buildProxies(
      assets,
      cacheDirFor(project.path),
      (progress: ProxyProgress) => this.emit('proxies:progress', progress),
      { jobs: settings.parallelJobs, background: settings.lowPriority },
    )
    this.proxies = job
    try {
      const updated = await job.promise
      if (updated.length === 0) return { built: 0, receipt: null }
      const args = {
        proxies: updated.map((asset) => ({ assetId: asset.id, proxyPath: asset.proxyPath ?? null })),
      }
      return { built: updated.length, receipt: record(args) }
    } finally {
      this.proxies = null
      this.emit('proxies:done')
    }
  }

  cancelProxies(): boolean {
    if (!this.proxies) return false
    this.proxies.cancel()
    return true
  }

  // --- Cache ---------------------------------------------------------------

  usage(project: Project): Promise<CacheUsage> {
    return cacheUsage(cacheDirFor(project.path))
  }

  /**
   * Empties the chosen parts of the cache.
   *
   * Purging proxies also takes their paths out of the project, in one undoable
   * step: a clip left pointing at a deleted proxy would fail its next render
   * with a missing-file error about a file the user never chose.
   */
  async clearCache(
    store: ProjectStore,
    categories: readonly CacheCategory[],
    record: RecordProxyPaths,
  ): Promise<{ files: number; bytes: number; receipt: Receipt | null }> {
    if (categories.includes('preview')) this.cancelPreview()
    if (categories.includes('proxies') && this.proxies) {
      throw new OpError('refused', 'proxies are being built; cancel that first')
    }
    const freed = await clearCache(cacheDirFor(store.project.path), categories)
    let receipt: Receipt | null = null
    if (categories.includes('proxies')) {
      const proxied = store.project.assets.filter((asset) => asset.proxyPath)
      if (proxied.length > 0) {
        const args = { proxies: proxied.map((asset) => ({ assetId: asset.id, proxyPath: null })) }
        receipt = record(args)
      }
    }
    return { ...freed, receipt }
  }
}

/** The app has one media host; the UI and the MCP tools share it. */
export const media = new MediaHost()
