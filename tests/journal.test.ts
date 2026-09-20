/**
 * The action journal and selective undo.
 *
 * Reverting one entry in the middle has to keep the ones after it, which means
 * re-running them on top of the restored state — these tests are mostly about
 * that replay behaving, including when it cannot.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import type { MediaAsset, Project } from '../src/core/model.js'
import * as ops from '../src/core/ops.js'
import { ProjectStore, type Replayer } from '../src/main/project/store.js'

const MEDIA: MediaAsset = {
  id: 'asset-1', path: 'C:/m/a.mp4', name: 'a.mp4', type: 'video',
  durationSeconds: 60, width: 1920, height: 1080, fps: 30,
  hasAudio: false, sampleRate: 0, channels: 0, thumbnailPath: null,
}

/** The main process supplies this; here it is the ops table, same idea. */
const UI_OPS: Record<string, (project: Project, args: any) => ops.MutationResult> = {
  addClips: ops.addClips,
  splitClips: ops.splitClips,
  setClipProperties: ops.setClipProperties,
  addMarkers: ops.addMarkers,
}

const replayer: Replayer = async (_source, name, args, project) => {
  const operation = UI_OPS[name]
  if (!operation) throw new Error(`unknown operation "${name}"`)
  return operation(project, args)
}

let store: ProjectStore

function seeded(): Project {
  return ops.addAssets(ops.emptyProject('J'), [MEDIA]).project
}

beforeEach(() => {
  store = new ProjectStore(seeded())
  store.setReplayer(replayer)
})

function addClip(durationFrames: number, startFrame?: number) {
  const args = { clips: [{ assetId: MEDIA.id, durationFrames, ...(startFrame === undefined ? {} : { startFrame }) }] }
  return store.apply((p) => ops.addClips(p, args), { source: 'ui', name: 'addClips', args })
}

describe('journal', () => {
  it('records who made each edit', () => {
    addClip(60)
    store.apply((p) => ops.addMarkers(p, { markers: [{ startFrame: 10, name: 'beat' }] }), {
      source: 'agent',
      name: 'addMarkers',
      args: { markers: [{ startFrame: 10, name: 'beat' }] },
    })
    expect(store.journal.map((entry) => entry.source)).toEqual(['ui', 'agent'])
    expect(store.journal.every((entry) => entry.replayable)).toBe(true)
  })

  it('leaves no entry for an operation that changed nothing', () => {
    addClip(60)
    const clipId = store.project.timelines[0]!.tracks[0]!.clips[0]!.id
    // The clip is already fully opaque, so this is a no-op, not an edit.
    const args = { clipIds: [clipId], properties: { opacity: 1 } }
    const receipt = store.apply((p) => ops.setClipProperties(p, args), {
      source: 'ui',
      name: 'setClipProperties',
      args,
    })
    expect(receipt.changed).toBe(false)
    expect(store.journal).toHaveLength(1)
  })

  it('marks an edit with no recorded arguments as not replayable', () => {
    store.apply((p) => ops.addClips(p, { clips: [{ assetId: MEDIA.id, durationFrames: 30 }] }))
    expect(store.journal[0]!.replayable).toBe(false)
    expect(store.journal[0]!.source).toBe('ui')
  })

  it('rewinds with undo and comes back with redo', () => {
    addClip(60)
    addClip(30)
    expect(store.journal).toHaveLength(2)

    store.undo()
    expect(store.journal).toHaveLength(1)

    store.redo()
    expect(store.journal).toHaveLength(2)
  })

  it('forgets everything when a project is loaded over the top', () => {
    addClip(60)
    store.replace(seeded())
    expect(store.journal).toHaveLength(0)
  })
})

describe('revertEntry', () => {
  const clipCount = () => store.project.timelines[0]!.tracks.reduce((n, t) => n + t.clips.length, 0)

  it('undoes the most recent entry like a plain undo', async () => {
    addClip(60)
    addClip(30)
    const last = store.journal[1]!

    const receipt = await store.revertEntry(last.id)
    expect(receipt.changed).toBe(true)
    expect(clipCount()).toBe(1)
    expect(store.journal).toHaveLength(1)
  })

  it('undoes an entry in the middle and keeps the later ones', async () => {
    addClip(60)
    const middle = store.journal[0]!
    addClip(40, 200)
    store.apply((p) => ops.addMarkers(p, { markers: [{ startFrame: 5, name: 'x' }] }), {
      source: 'agent',
      name: 'addMarkers',
      args: { markers: [{ startFrame: 5, name: 'x' }] },
    })

    const receipt = await store.revertEntry(middle.id)
    expect(receipt.changed).toBe(true)
    // The first clip is gone; the second clip and the marker survived.
    expect(clipCount()).toBe(1)
    expect(store.project.timelines[0]!.tracks[0]!.clips[0]!.durationFrames).toBe(40)
    expect(store.project.timelines[0]!.markers).toHaveLength(1)
    expect(store.journal.map((entry) => entry.operation)).toEqual(['add_clips', 'add_markers'])
  })

  it('reports later actions it could not re-run instead of pretending they applied', async () => {
    addClip(60)
    const first = store.journal[0]!
    const clipId = store.project.timelines[0]!.tracks[0]!.clips[0]!.id
    // Splitting that very clip cannot survive its creation being undone.
    store.apply((p) => ops.splitClips(p, { frame: 30, clipIds: [clipId] }), {
      source: 'agent',
      name: 'splitClips',
      args: { frame: 30, clipIds: [clipId] },
    })

    const receipt = await store.revertEntry(first.id)
    expect(receipt.changed).toBe(true)
    expect(clipCount()).toBe(0)
    expect(receipt.warnings.join(' ')).toMatch(/1 later action\(s\) no longer applied/)
    expect(store.journal).toHaveLength(0)
  })

  it('refuses when a later entry has no arguments to re-run', async () => {
    addClip(60)
    const first = store.journal[0]!
    store.apply((p) => ops.addMarkers(p, { markers: [{ startFrame: 3, name: 'y' }] }))

    await expect(store.revertEntry(first.id)).rejects.toThrow(/cannot be re-run/)
    expect(clipCount()).toBe(1)
  })

  it('is itself undoable', async () => {
    addClip(60)
    addClip(30)
    await store.revertEntry(store.journal[1]!.id)
    expect(clipCount()).toBe(1)

    store.undo()
    expect(clipCount()).toBe(2)
  })

  it('says so plainly when the entry is gone', async () => {
    const receipt = await store.revertEntry('not-an-entry')
    expect(receipt.changed).toBe(false)
    expect(receipt.summary).toMatch(/No journal entry/)
  })
})

describe('runAttributed', () => {
  it('labels everything an invocation touches, then restores the previous label', () => {
    store.runAttributed({ source: 'agent', name: 'add_clips', args: { n: 1 } }, () => {
      store.apply((p) => ops.addClips(p, { clips: [{ assetId: MEDIA.id, durationFrames: 20 }] }))
    })
    store.apply((p) => ops.addClips(p, { clips: [{ assetId: MEDIA.id, durationFrames: 20 }] }))

    expect(store.journal.map((entry) => entry.source)).toEqual(['agent', 'ui'])
    expect(store.journal[0]!.replayable).toBe(true)
    expect(store.journal[1]!.replayable).toBe(false)
  })
})
