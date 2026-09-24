/**
 * Proxy clips.
 *
 * A proxy is a low-resolution, all-intra copy of a source file. Decoding 4K
 * H.264 with long GOPs makes scrubbing on a laptop miserable; a 640-wide
 * all-intra copy seeks in a single frame's work. The proxy stands in for
 * preview and playback only — `useProxies` is never set on an export, so what
 * is delivered is always built from the originals.
 *
 * All-intra is a trade, not a free win: every frame being a keyframe costs disk
 * space, and on an already-small file it would cost more than it saves. That is
 * why only footage wider than the proxy itself is worth transcoding.
 *
 * Proxies are cached beside the project and keyed by the source's path, size
 * and mtime, so replacing a file on disk invalidates its proxy instead of
 * silently editing against the old picture.
 */

import { createHash } from 'node:crypto'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'

import type { MediaAsset } from '../../core/model.js'
import { commitPartial, FFMPEG_PATH, FFmpegError, lowerPriority, partialPath } from './ffmpeg.js'
import { spawn } from 'node:child_process'
import { runPool } from './pool.js'

/** Long edge of a proxy, in pixels. Small enough to be cheap, big enough to cut on. */
export const PROXY_WIDTH = 640

export const PROXY_DIR_NAME = 'proxy'

export interface ProxyJob {
  promise: Promise<MediaAsset[]>
  cancel: () => void
}

export function proxyDirFor(cacheDir: string): string {
  return join(cacheDir, PROXY_DIR_NAME)
}

/**
 * Whether a proxy would actually help.
 *
 * A still decodes instantly, and footage no wider than the proxy would gain
 * nothing while costing more disk than the original — so both are left alone.
 */
export function canProxy(asset: MediaAsset): boolean {
  return asset.type === 'video' && asset.width > PROXY_WIDTH
}

/**
 * Cache key for a source file.
 *
 * Path alone is not enough — a re-export over the same name would keep the old
 * proxy and quietly show the wrong footage.
 */
async function fingerprint(asset: MediaAsset): Promise<string> {
  let size = 0
  let mtime = 0
  try {
    const info = await stat(asset.path)
    size = info.size
    mtime = Math.round(info.mtimeMs)
  } catch {
    // A missing source produces a key that cannot collide with a real one.
  }
  return createHash('sha1').update(`${asset.path}|${size}|${mtime}`).digest('hex').slice(0, 16)
}

export async function proxyPathFor(asset: MediaAsset, cacheDir: string): Promise<string> {
  return join(proxyDirFor(cacheDir), `${await fingerprint(asset)}.mp4`)
}

/**
 * A proxy counts only if it holds something — the same rule the preview cache
 * learned the hard way. `existsSync` took an empty file left by a killed
 * transcode for a finished proxy, and the editor then cut on nothing.
 */
function usable(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

/** The proxy for this asset if one is already on disk and current. */
export async function existingProxy(asset: MediaAsset, cacheDir: string): Promise<string | null> {
  if (!canProxy(asset)) return null
  const path = await proxyPathFor(asset, cacheDir)
  return usable(path) ? path : null
}

export interface ProxyOptions {
  /** Transcodes run at the same time. */
  jobs?: number
  /** Run below normal priority, so the editor stays responsive meanwhile. */
  background?: boolean
}

/** The FFmpeg arguments for one proxy. Exported so tests can read them. */
export function proxyArgs(asset: MediaAsset, outputPath: string): string[] {
  // `-g 1` is the whole point: every frame a keyframe, so a seek costs one
  // frame of decoding instead of rewinding to the last I-frame. `fastdecode`
  // drops the CABAC and deblocking work the decoder would otherwise redo on
  // every one of those frames.
  return [
    '-hide_banner', '-nostdin', '-y',
    '-i', asset.path,
    '-vf', `scale=${PROXY_WIDTH}:-2:flags=fast_bilinear`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '26', '-g', '1',
    '-pix_fmt', 'yuv420p',
    ...(asset.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    outputPath,
  ]
}

function transcode(
  asset: MediaAsset,
  outputPath: string,
  signal: AbortSignal,
  background: boolean,
): Promise<void> {
  const args = proxyArgs(asset, outputPath)

  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true })
    if (background) lowerPriority(child.pid)
    let stderr = ''
    const abort = () => child.kill('SIGKILL')
    signal.addEventListener('abort', abort)

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 40_000) stderr = stderr.slice(-20_000)
    })
    child.on('error', (error) => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) return reject(new Error('cancelled'))
      if (code === 0) return resolve()
      reject(new FFmpegError(`building a proxy for ${asset.name} failed`, stderr, code))
    })
  })
}

export interface ProxyProgress {
  assetId: string
  name: string
  done: number
  total: number
}

/**
 * Builds proxies for the given assets, skipping ones already cached.
 *
 * Several at once when the settings allow it — a card dump of forty clips is
 * exactly when proxies are wanted, and one transcode at a time leaves most of
 * the machine idle. Each one is written beside its final name and renamed when
 * complete, so a crash never leaves a truncated proxy that looks finished.
 *
 * Returns the assets that gained a proxy, so the caller can write the paths
 * into the project in a single operation rather than one per file.
 */
export function buildProxies(
  assets: MediaAsset[],
  cacheDir: string,
  onProgress?: (progress: ProxyProgress) => void,
  options: ProxyOptions = {},
): ProxyJob {
  const controller = new AbortController()

  const promise = (async () => {
    const targets = assets.filter(canProxy)
    const updated: MediaAsset[] = []
    await mkdir(proxyDirFor(cacheDir), { recursive: true })
    let done = 0

    await runPool(targets, options.jobs ?? 1, async (asset) => {
      if (controller.signal.aborted) return
      onProgress?.({ assetId: asset.id, name: asset.name, done, total: targets.length })

      const path = await proxyPathFor(asset, cacheDir)
      if (usable(path)) {
        if (asset.proxyPath !== path) updated.push({ ...asset, proxyPath: path })
        done++
        return
      }
      const partial = partialPath(path)
      try {
        await transcode(asset, partial, controller.signal, options.background ?? false)
        await commitPartial(partial, path)
        updated.push({ ...asset, proxyPath: path })
        done++
      } catch (error) {
        await unlink(partial).catch(() => {})
        if (controller.signal.aborted) return
        throw error
      }
    })

    onProgress?.({ assetId: '', name: '', done: targets.length, total: targets.length })
    // Same order as the input, whatever order the lanes finished in.
    return targets.flatMap((asset) => updated.filter((u) => u.id === asset.id))
  })()

  return { promise, cancel: () => controller.abort() }
}
