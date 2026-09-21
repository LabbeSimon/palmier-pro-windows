/**
 * Opening a plain folder.
 *
 * A folder without a project is not an error, it is a project waiting to be
 * made — so what matters is that the folder is left alone apart from the two
 * things the app owns, and that what it writes can be read straight back.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FFMPEG_PATH, probeAsset } from '../src/main/media/ffmpeg.js'
import { createProjectIn, isProjectFolder, loadProject } from '../src/main/project/store.js'

const exec = promisify(execFile)

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'palmier-open-'))
}, 60_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A folder of rushes, plus the clutter a real one always has. */
async function rushesFolder(name: string, files = 2): Promise<string> {
  const folder = join(root, name)
  await mkdir(folder, { recursive: true })
  for (let i = 1; i <= files; i++) {
    // The binary the app itself resolves, not whatever the PATH happens to hold:
    // a CI runner has no system ffmpeg.
    await exec(FFMPEG_PATH, [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=160x90:rate=30:duration=1`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(folder, `take0${i}.mp4`),
    ])
  }
  await writeFile(join(folder, 'notes.txt'), 'pas un rush')
  return folder
}

describe('createProjectIn', () => {
  it('turns a folder of rushes into a project that opens', async () => {
    const folder = await rushesFolder('Tournage')
    expect(await isProjectFolder(folder)).toBe(false)

    const { project, imported, failures } = await createProjectIn(folder, probeAsset)
    expect(failures).toEqual([])
    expect(imported).toHaveLength(2)
    expect(project.name).toBe('Tournage')

    // Read back through the real loader, not through what we just held in memory.
    expect(await isProjectFolder(folder)).toBe(true)
    const reopened = await loadProject(folder)
    expect(reopened.assets.map((a) => a.name).sort()).toEqual(['take01.mp4', 'take02.mp4'])
    expect(reopened.timelines).toHaveLength(1)
  }, 240_000)

  it('touches nothing in the folder but the two things the app owns', async () => {
    const folder = await rushesFolder('Intact', 1)
    const before = (await readdir(folder)).sort()
    await createProjectIn(folder, probeAsset)
    const after = (await readdir(folder)).sort()

    expect(after.filter((name) => !before.includes(name)).sort()).toEqual(['cache', 'project.json'])
    // Every original file is still there, including the one that is not media.
    expect(before.every((name) => after.includes(name))).toBe(true)
  }, 240_000)

  it('works on an empty folder, leaving an empty bin', async () => {
    const folder = join(root, 'Vide')
    await mkdir(folder, { recursive: true })
    const { imported, project } = await createProjectIn(folder, probeAsset)
    expect(imported).toEqual([])
    expect(project.assets).toEqual([])
    expect(await isProjectFolder(folder)).toBe(true)
  }, 60_000)

  it('names the files it could not read instead of failing the whole folder', async () => {
    const folder = await rushesFolder('Abime', 1)
    // An .mp4 that is not one: real card dumps do contain these.
    await writeFile(join(folder, 'corrompu.mp4'), 'ceci n est pas une video')

    const { imported, failures } = await createProjectIn(folder, probeAsset)
    expect(imported).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/corrompu\.mp4/)
  }, 240_000)

  it('drops the .palmier suffix from the project name', async () => {
    const folder = join(root, 'Clip musical.palmier')
    await mkdir(folder, { recursive: true })
    const { project } = await createProjectIn(folder, probeAsset)
    expect(project.name).toBe('Clip musical')
  }, 60_000)
})
