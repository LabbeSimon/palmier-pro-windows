/**
 * Performance settings — the knobs Kdenlive spreads over its configuration
 * pages (timeline preview, proxy clips, cached data), in one place.
 *
 * They belong to the machine, not to the project: how many encodes a laptop can
 * run at once or how much disk it can spare says nothing about the edit. So
 * they live in the user profile, and the same values are read and written by
 * the settings dialog and by the MCP tools — one validation, one file.
 */

import { cpus } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { OpError } from '../../core/ops.js'

/** Preview proxy heights offered, as in Kdenlive's preview resolution menu. */
export const PREVIEW_HEIGHTS = [360, 540, 720, 1080] as const
export type PreviewHeight = (typeof PREVIEW_HEIGHTS)[number]

export interface PerformanceSettings {
  /** Height the timeline preview is rendered at. */
  previewHeight: PreviewHeight
  /** Preview slices and proxies encoded at the same time. */
  parallelJobs: number
  /** Run preview and proxy encodes below normal priority, so editing stays fluid. */
  lowPriority: boolean
  /** Decode sources on the GPU. Only honoured when the probe says it works. */
  hardwareDecode: boolean
  /**
   * Encode dirty preview slices by themselves after a pause in editing.
   *
   * Off by default, as in Kdenlive: encoding on every keystroke would burn the
   * machine. When on, it waits for a pause, runs below normal priority, and is
   * dropped the moment the edit changes — finished slices stay cached.
   */
  autoPreview: boolean
  /** Ceiling for regenerable cache data (preview slices, frames), in GB. */
  cacheLimitGB: number
}

export const MAX_PARALLEL_JOBS = 8

/**
 * Half the logical cores, capped at three.
 *
 * Measured on four cores, six 1080p-sourced slices: one encode at a time
 * 6.1 s, two 5.0 s, three 4.9 s. Much of the filter graph runs on a single
 * thread, so a lone FFmpeg leaves cores idle — but the gain flattens as soon
 * as the encodes start sharing cores, and each one holds its own decoders.
 */
export function defaultParallelJobs(): number {
  return Math.max(1, Math.min(3, Math.floor(cpus().length / 2)))
}

export function defaultPerformance(): PerformanceSettings {
  return {
    previewHeight: 540,
    parallelJobs: defaultParallelJobs(),
    lowPriority: true,
    hardwareDecode: false,
    autoPreview: false,
    cacheLimitGB: 10,
  }
}

let current: PerformanceSettings = defaultPerformance()
let file: string | null = null

/**
 * Checks an update and names every value it refuses.
 *
 * All problems at once, not the first one: an agent that sends three settings
 * and hears about one mistake at a time needs three round trips to learn what
 * one answer could have told it.
 */
export function validatePerformance(update: Partial<PerformanceSettings>): Partial<PerformanceSettings> {
  const problems: string[] = []
  const clean: Partial<PerformanceSettings> = {}
  const known = new Set(Object.keys(defaultPerformance()))
  for (const key of Object.keys(update)) {
    if (!known.has(key)) problems.push(`unknown setting "${key}"`)
  }

  if (update.previewHeight !== undefined) {
    if (!PREVIEW_HEIGHTS.includes(update.previewHeight)) {
      problems.push(`previewHeight must be one of ${PREVIEW_HEIGHTS.join(', ')} (got ${update.previewHeight})`)
    } else clean.previewHeight = update.previewHeight
  }
  if (update.parallelJobs !== undefined) {
    const jobs = update.parallelJobs
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_PARALLEL_JOBS) {
      problems.push(`parallelJobs must be an integer from 1 to ${MAX_PARALLEL_JOBS} (got ${jobs})`)
    } else clean.parallelJobs = jobs
  }
  if (update.cacheLimitGB !== undefined) {
    const limit = update.cacheLimitGB
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0.5 || limit > 500) {
      problems.push(`cacheLimitGB must be between 0.5 and 500 (got ${limit})`)
    } else clean.cacheLimitGB = limit
  }
  for (const key of ['lowPriority', 'hardwareDecode', 'autoPreview'] as const) {
    if (update[key] === undefined) continue
    if (typeof update[key] !== 'boolean') problems.push(`${key} must be true or false (got ${update[key]})`)
    else clean[key] = update[key]
  }

  if (problems.length > 0) throw new OpError('invalid_argument', problems.join('; '))
  return clean
}

export function getPerformance(): PerformanceSettings {
  return { ...current }
}

/**
 * Applies an update and writes it to disk when a file is configured.
 *
 * The write goes through a temporary file and a rename, so a crash mid-write
 * leaves the previous settings rather than a truncated JSON file that would
 * silently reset everything on the next start.
 */
export async function setPerformance(update: Partial<PerformanceSettings>): Promise<PerformanceSettings> {
  const clean = validatePerformance(update)
  current = { ...current, ...clean }
  if (file) {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.tmp`
    await writeFile(temporary, JSON.stringify(current, null, 2), 'utf8')
    await rename(temporary, file)
  }
  return getPerformance()
}

/**
 * Loads settings from the user profile. Values that no longer validate are
 * dropped one by one, so a single bad entry does not throw away the rest.
 */
export async function loadPerformance(path: string): Promise<PerformanceSettings> {
  file = path
  current = defaultPerformance()
  let stored: Record<string, unknown> = {}
  try {
    stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return getPerformance()
  }
  for (const [key, value] of Object.entries(stored)) {
    try {
      current = { ...current, ...validatePerformance({ [key]: value } as Partial<PerformanceSettings>) }
    } catch {
      // Keep the default for this one.
    }
  }
  return getPerformance()
}

/** Back to defaults and no file. Tests use it; nothing else should need to. */
export function resetPerformance(): void {
  current = defaultPerformance()
  file = null
}
