/**
 * The project cache, seen as one thing: how big it is, what it is made of, and
 * how it is kept bounded.
 *
 * Kdenlive shows this under "Cached data" with a purge button per kind; the
 * same split is used here, and the MCP tools read the very same numbers.
 *
 * Two kinds of data live here and they are not treated alike:
 * - regenerable in seconds — preview slices, stitched previews, monitor
 *   frames. These are evicted automatically, least recently *used* first,
 *   once the cache passes its ceiling.
 * - expensive — proxies and posters. A proxy can take minutes per clip, so it
 *   is never evicted behind the user's back, only on an explicit purge.
 */

import { readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

import { PARTIAL_MARKER } from './ffmpeg.js'

export const CACHE_CATEGORIES = ['preview', 'frames', 'proxies', 'thumbnails'] as const
export type CacheCategory = (typeof CACHE_CATEGORIES)[number]

export const PREVIEW_CHUNK_DIR = 'preview-chunks'
export const FRAME_DIR = 'frames'
export const PROXY_DIR = 'proxy'

/** A partial file this old belongs to a process that is gone. */
const STALE_PARTIAL_MS = 30 * 60 * 1000

interface CacheFile {
  path: string
  name: string
  category: CacheCategory
  bytes: number
  mtimeMs: number
}

async function list(directory: string): Promise<{ name: string; path: string; bytes: number; mtimeMs: number }[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const entries = await Promise.all(
    names.map(async (name) => {
      const path = join(directory, name)
      try {
        const info = await stat(path)
        return info.isFile() ? { name, path, bytes: info.size, mtimeMs: info.mtimeMs } : null
      } catch {
        return null
      }
    }),
  )
  return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
}

/** Which category a file directly under the cache root belongs to, if any. */
function rootCategory(name: string): CacheCategory | null {
  if (name.startsWith('preview-') && name.endsWith('.mp4')) return 'preview'
  // Monitor frames from before they had their own folder, and clip-monitor stills.
  if (name.startsWith('preview-') && name.endsWith('.png')) return 'frames'
  if (name.startsWith('clip-') && name.endsWith('.jpg')) return 'frames'
  if (name.endsWith('.jpg')) return 'thumbnails'
  return null
}

/** Every file the cache knows about, by category. Unknown files are left alone. */
export async function cacheFiles(cacheDir: string): Promise<CacheFile[]> {
  const files: CacheFile[] = []
  for (const entry of await list(cacheDir)) {
    const category = rootCategory(entry.name)
    if (category) files.push({ ...entry, category })
  }
  const nested: [string, CacheCategory][] = [
    [PREVIEW_CHUNK_DIR, 'preview'],
    [FRAME_DIR, 'frames'],
    [PROXY_DIR, 'proxies'],
  ]
  for (const [directory, category] of nested) {
    for (const entry of await list(join(cacheDir, directory))) files.push({ ...entry, category })
  }
  return files
}

export interface CacheUsage {
  directory: string
  totalBytes: number
  categories: Record<CacheCategory, { files: number; bytes: number }>
}

export async function cacheUsage(cacheDir: string): Promise<CacheUsage> {
  const categories = Object.fromEntries(
    CACHE_CATEGORIES.map((category) => [category, { files: 0, bytes: 0 }]),
  ) as CacheUsage['categories']
  let totalBytes = 0
  for (const file of await cacheFiles(cacheDir)) {
    categories[file.category].files++
    categories[file.category].bytes += file.bytes
    totalBytes += file.bytes
  }
  return { directory: cacheDir, totalBytes, categories }
}

/** Deletes every file of the given categories. Returns what was freed. */
export async function clearCache(
  cacheDir: string,
  categories: readonly CacheCategory[],
): Promise<{ files: number; bytes: number }> {
  const wanted = new Set(categories)
  let files = 0
  let bytes = 0
  for (const file of await cacheFiles(cacheDir)) {
    if (!wanted.has(file.category)) continue
    try {
      await rm(file.path, { force: true })
      files++
      bytes += file.bytes
    } catch {
      // Locked by the player on Windows, most likely; it goes next time.
    }
  }
  return { files, bytes }
}

/**
 * Marks a cached file as just used.
 *
 * Eviction goes by modification time, so a slice reused on every preview must
 * look recent — otherwise the slices someone watches all day would be the
 * first to go, being the oldest ones written.
 */
export async function touch(paths: string[]): Promise<void> {
  const now = new Date()
  await Promise.all(paths.map((path) => utimes(path, now, now).catch(() => {})))
}

/**
 * Brings regenerable data back under the ceiling, least recently used first,
 * and sweeps partial files left by a process that died.
 *
 * `keep` holds paths the caller is about to use; they are never evicted, even
 * when that leaves the cache over its limit — deleting the preview someone is
 * about to play would be absurd.
 */
export async function enforceCacheLimit(
  cacheDir: string,
  limitBytes: number,
  keep: ReadonlySet<string> = new Set(),
): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const all = await cacheFiles(cacheDir)
  const now = Date.now()

  const remove = async (file: CacheFile) => {
    try {
      await rm(file.path, { force: true })
      files++
      bytes += file.bytes
      return true
    } catch {
      return false
    }
  }

  const survivors: CacheFile[] = []
  for (const file of all) {
    if (file.name.includes(PARTIAL_MARKER) && now - file.mtimeMs > STALE_PARTIAL_MS) {
      await remove(file)
    } else {
      survivors.push(file)
    }
  }

  let total = survivors.reduce((sum, file) => sum + file.bytes, 0)
  if (total <= limitBytes) return { files, bytes }

  const evictable = survivors
    .filter((file) => file.category === 'preview' || file.category === 'frames')
    .filter((file) => !keep.has(file.path) && !file.name.includes(PARTIAL_MARKER))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)

  for (const file of evictable) {
    if (total <= limitBytes) break
    if (await remove(file)) total -= file.bytes
  }
  return { files, bytes }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
