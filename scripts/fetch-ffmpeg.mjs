#!/usr/bin/env node
/**
 * Downloads the FFmpeg binaries the Windows package ships.
 *
 * Kept out of npm dependencies on purpose: the popular installer packages are
 * pinned to 2018 builds, which are missing filters this editor's render graph
 * relies on. This pulls a current official build instead.
 *
 *   node scripts/fetch-ffmpeg.mjs            # win32-x64, what package:win needs
 *   node scripts/fetch-ffmpeg.mjs linux-x64  # optional, for headless render hosts
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS = process.platform === 'win32'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const BUILDS = {
  // gyan.dev publishes the reference Windows builds; "essentials" carries x264/x265/aac.
  'win32-x64': {
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    archive: 'zip',
    binaries: ['ffmpeg.exe', 'ffprobe.exe'],
  },
  // NOT johnvansickle: those static builds advertise --enable-libfreetype in their
  // configure line but ship without the drawtext filter, which every text clip needs.
  'linux-x64': {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
    archive: 'tar.xz',
    binaries: ['ffmpeg', 'ffprobe'],
  },
}

const target = process.argv[2] ?? 'win32-x64'
const build = BUILDS[target]
if (!build) {
  console.error(`unknown target "${target}". Known: ${Object.keys(BUILDS).join(', ')}`)
  process.exit(1)
}

const destination = join(ROOT, 'resources', 'ffmpeg', target)
if (build.binaries.every((binary) => existsSync(join(destination, binary)))) {
  console.log(`${target}: already present in resources/ffmpeg/${target}, nothing to do`)
  process.exit(0)
}

const scratch = join(ROOT, '.ffmpeg-download')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
mkdirSync(destination, { recursive: true })

const archivePath = join(scratch, `ffmpeg.${build.archive}`)
console.log(`Downloading ${build.url}`)
// Node's own fetch rather than curl: this script runs on the Windows CI runner
// too, and every external tool it needs is one more thing that is not there.
const response = await fetch(build.url, { redirect: 'follow' })
if (!response.ok) {
  console.error(`download failed: HTTP ${response.status} ${response.statusText}`)
  process.exit(1)
}
writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()))

console.log('Extracting')
if (build.archive === 'zip' && !WINDOWS) {
  execFileSync('unzip', ['-q', '-o', archivePath, '-d', scratch], { stdio: 'inherit' })
} else {
  // Windows ships bsdtar as `tar`, which reads zip as well as tar.xz. GNU tar
  // on Linux cannot read zip, hence the split above.
  execFileSync('tar', ['-xf', archivePath, '-C', scratch], { stdio: 'inherit' })
}

/** First file with this name anywhere under `directory`. */
function locate(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const found = locate(path, name)
      if (found) return found
    } else if (entry.name === name) {
      return path
    }
  }
  return null
}

// Both archives nest the binaries one level down under a versioned directory.
for (const binary of build.binaries) {
  const found = locate(scratch, binary)
  if (!found) {
    console.error(`${binary} was not found inside the archive`)
    process.exit(1)
  }
  copyFileSync(found, join(destination, binary))
  if (!WINDOWS) chmodSync(join(destination, binary), 0o755)
  console.log(`  ${binary} -> resources/ffmpeg/${target}/${binary}`)
}

rmSync(scratch, { recursive: true, force: true })

// Guard against a build that looks complete but lacks a filter the render graph needs.
// Only checkable for the host platform; a cross-target build is verified by CI on that OS.
const REQUIRED_FILTERS = ['drawtext', 'overlay', 'amix', 'alimiter', 'atempo', 'afade']
const hostTarget = `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`
if (target === hostTarget) {
  const binary = join(destination, build.binaries[0])
  const filters = execFileSync(binary, ['-hide_banner', '-filters'], { encoding: 'utf8' })
  const missing = REQUIRED_FILTERS.filter((name) => !new RegExp(`\\s${name}\\s`).test(filters))
  if (missing.length > 0) {
    console.error(`This FFmpeg build is missing required filters: ${missing.join(', ')}`)
    console.error('Text clips and the audio mix would fail at render time. Pick another build.')
    process.exit(1)
  }
  console.log(`Verified: ${REQUIRED_FILTERS.length} required filters present.`)
}

console.log(`Done. ${target} binaries are ready.`)
