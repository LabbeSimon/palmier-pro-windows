#!/usr/bin/env node
/**
 * Downloads Noto Sans, the typeface KDE — and therefore Kdenlive — ships with.
 *
 * Kept out of the repository on purpose: the project's convention is to
 * redistribute no third-party material, so the font is fetched at build time
 * exactly like the FFmpeg binaries. Noto Sans is SIL OFL 1.1, which permits
 * bundling inside the packaged application.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEST = join(ROOT, 'resources', 'fonts')

// Static weights only: the UI uses four, and a variable font would ship far more.
const FACES = [
  { file: 'NotoSans-Regular.ttf', weight: 400 },
  { file: 'NotoSans-Medium.ttf', weight: 500 },
  { file: 'NotoSans-SemiBold.ttf', weight: 600 },
  { file: 'NotoSans-Bold.ttf', weight: 700 },
]

const BASE =
  'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSans/hinted/ttf'

const MONO = {
  file: 'NotoSansMono-Regular.ttf',
  url: 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansMono/hinted/ttf/NotoSansMono-Regular.ttf',
}

mkdirSync(DEST, { recursive: true })

let fetched = 0
for (const face of FACES) {
  const target = join(DEST, face.file)
  if (existsSync(target)) continue
  console.log(`Downloading ${face.file}`)
  execFileSync('curl', ['-fL', '--retry', '3', '-o', target, `${BASE}/${face.file}`], {
    stdio: 'inherit',
  })
  fetched++
}

if (!existsSync(join(DEST, MONO.file))) {
  console.log(`Downloading ${MONO.file}`)
  execFileSync('curl', ['-fL', '--retry', '3', '-o', join(DEST, MONO.file), MONO.url], {
    stdio: 'inherit',
  })
  fetched++
}

// The OFL requires the licence to travel with the fonts.
writeFileSync(
  join(DEST, 'LICENSE.txt'),
  [
    'Noto Sans and Noto Sans Mono are licensed under the SIL Open Font License 1.1.',
    'https://openfontlicense.org',
    'https://github.com/notofonts/notofonts.github.io',
    '',
    'These files are downloaded at build time and are not part of this repository.',
  ].join('\n'),
)

console.log(fetched === 0 ? 'Fonts already present.' : `Done. ${fetched} font file(s) ready.`)
