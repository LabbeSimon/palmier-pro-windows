/**
 * The single owner of mutable project state.
 *
 * Every surface — UI, MCP tools, tests — mutates through `apply`, so undo history
 * and change notifications stay consistent no matter who made the edit.
 */

import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { PROJECT_FILE_VERSION, type Project, type ProjectFile } from '../../core/model.js'
import { emptyProject, OpError, type MutationResult, type Receipt } from '../../core/ops.js'

const UNDO_DEPTH = 100
const JOURNAL_DEPTH = 200

export interface UndoEntry {
  project: Project
  label: string
}

/** Who made an edit, and — when it can be replayed — exactly what it was. */
export interface Attribution {
  source: 'ui' | 'agent' | 'mcp'
  /** Name in the replay registry: an IPC op name for `ui`, a tool name otherwise. */
  name?: string
  args?: unknown
}

export interface JournalEntry {
  id: string
  at: string
  source: Attribution['source']
  operation: string
  summary: string
  affectedIds: string[]
  warnings: string[]
  /** True when the entry carries enough to be replayed after an earlier revert. */
  replayable: boolean
}

interface JournalRecord extends JournalEntry {
  /** State immediately before this entry, which is what reverting restores. */
  before: Project
  name?: string
  args?: unknown
}

/**
 * Re-runs a recorded edit during a revert. Supplied by the main process so the
 * store stays free of any knowledge of IPC names or the tool registry.
 *
 * Asynchronous because importing media is a legitimate agent action and reading
 * a file cannot be made synchronous.
 */
export type Replayer = (
  source: Attribution['source'],
  name: string,
  args: unknown,
  project: Project,
) => Promise<MutationResult>

export class ProjectStore extends EventEmitter {
  private state: Project
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private dirty = false
  private records: JournalRecord[] = []
  /** Journal entries rewound by undo, waiting for a matching redo. */
  private undoneRecords: JournalRecord[] = []
  private replayer: Replayer | null = null
  /**
   * Set around a tool invocation so `apply` can label the entry without every
   * one of the tools having to pass it. A tool that mutates after an `await`
   * while another call is in flight can be mislabelled; that costs a wrong name
   * in the journal, never a wrong edit.
   */
  private attribution: Attribution | null = null

  constructor(initial: Project = emptyProject()) {
    super()
    this.state = initial
  }

  get project(): Project {
    return this.state
  }

  get isDirty(): boolean {
    return this.dirty
  }

  /** Teaches the store how to re-run a recorded edit; without it, no replay. */
  setReplayer(replayer: Replayer): void {
    this.replayer = replayer
  }

  /** Runs `fn` with every edit it causes attributed to `attribution`. */
  runAttributed<T>(attribution: Attribution, fn: () => T): T {
    const previous = this.attribution
    this.attribution = attribution
    try {
      return fn()
    } finally {
      this.attribution = previous
    }
  }

  /**
   * Runs a domain operation. A refused or unchanged operation leaves the undo
   * history untouched, so undo never swallows a no-op step.
   */
  apply(operation: (project: Project) => MutationResult, attribution?: Attribution): Receipt {
    const before = this.state
    const result = operation(before)
    if (!result.receipt.changed) return result.receipt

    this.undoStack.push({ project: before, label: result.receipt.summary })
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
    this.redoStack = []
    this.undoneRecords = []
    this.state = result.project
    this.dirty = true
    this.record(before, result.receipt, attribution ?? this.attribution ?? { source: 'ui' })
    this.emit('changed', this.state, result.receipt)
    return result.receipt
  }

  private record(before: Project, receipt: Receipt, attribution: Attribution): void {
    this.records.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      source: attribution.source,
      operation: receipt.operation,
      summary: receipt.summary,
      affectedIds: receipt.affectedIds,
      warnings: receipt.warnings,
      replayable: Boolean(attribution.name),
      before,
      name: attribution.name,
      args: attribution.args,
    })
    if (this.records.length > JOURNAL_DEPTH) this.records.shift()
  }

  get journal(): JournalEntry[] {
    return this.records.map(({ before: _before, name: _name, args: _args, ...entry }) => entry)
  }

  /**
   * Undoes one entry anywhere in the journal, keeping the ones after it.
   *
   * Restoring the snapshot alone would throw away every later edit, so the ones
   * after are re-run on top. A later edit that no longer makes sense — it
   * trimmed a clip this entry created, say — is reported by name rather than
   * quietly skipped, because the result on screen is then not what the journal
   * claims.
   */
  async revertEntry(entryId: string): Promise<Receipt> {
    const index = this.records.findIndex((entry) => entry.id === entryId)
    if (index === -1) {
      return {
        operation: 'revert_entry',
        changed: false,
        summary: `No journal entry ${entryId}`,
        affectedIds: [],
        warnings: [],
      }
    }

    const target = this.records[index]!
    const later = this.records.slice(index + 1)
    const blockers = later.filter((entry) => !entry.replayable || !this.replayer)
    if (blockers.length > 0) {
      throw new OpError(
        'refused',
        `Cannot undo "${target.summary}" on its own: ${blockers.length} later action(s) cannot be re-run ` +
          `(${blockers.map((b) => b.summary).join('; ')}). Undo those first.`,
      )
    }

    const before = this.state
    let project = target.before
    const replayed: JournalRecord[] = []
    const dropped: string[] = []
    for (const entry of later) {
      try {
        const result = await this.replayer!(entry.source, entry.name!, entry.args, project)
        if (!result.receipt.changed) {
          dropped.push(entry.summary)
          continue
        }
        project = result.project
        replayed.push({ ...entry, before: project })
      } catch (error) {
        dropped.push(`${entry.summary} — ${(error as Error).message}`)
      }
    }

    this.undoStack.push({ project: before, label: `undo of: ${target.summary}` })
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
    this.redoStack = []
    this.undoneRecords = []
    this.state = project
    this.dirty = true
    this.records = [...this.records.slice(0, index), ...replayed]

    const receipt: Receipt = {
      operation: 'revert_entry',
      changed: true,
      summary: `Undid: ${target.summary}`,
      affectedIds: target.affectedIds,
      warnings:
        dropped.length > 0
          ? [`${dropped.length} later action(s) no longer applied and were dropped: ${dropped.join('; ')}`]
          : [],
    }
    this.emit('changed', this.state, receipt)
    return receipt
  }

  /** Replaces state without an undo entry — for load and new-project only. */
  replace(project: Project): void {
    this.state = project
    this.undoStack = []
    this.redoStack = []
    this.records = []
    this.undoneRecords = []
    this.dirty = false
    this.emit('changed', this.state, {
      operation: 'load_project',
      changed: true,
      summary: `Opened "${project.name}"`,
      affectedIds: [project.id],
      warnings: [],
    })
  }

  undo(): Receipt {
    const entry = this.undoStack.pop()
    if (!entry) {
      return { operation: 'undo', changed: false, summary: 'Nothing to undo', affectedIds: [], warnings: [] }
    }
    // The journal is the same history seen from the other end, so it has to
    // rewind in step or it would list an action that is no longer in effect.
    const undone = this.records.pop()
    if (undone) this.undoneRecords.push(undone)
    this.redoStack.push({ project: this.state, label: entry.label })
    this.state = entry.project
    this.dirty = true
    const receipt: Receipt = {
      operation: 'undo',
      changed: true,
      summary: `Undid: ${entry.label}`,
      affectedIds: [],
      warnings: [],
    }
    this.emit('changed', this.state, receipt)
    return receipt
  }

  redo(): Receipt {
    const entry = this.redoStack.pop()
    if (!entry) {
      return { operation: 'redo', changed: false, summary: 'Nothing to redo', affectedIds: [], warnings: [] }
    }
    const restored = this.undoneRecords.pop()
    if (restored) this.records.push(restored)
    this.undoStack.push({ project: this.state, label: entry.label })
    this.state = entry.project
    this.dirty = true
    const receipt: Receipt = {
      operation: 'redo',
      changed: true,
      summary: `Redid: ${entry.label}`,
      affectedIds: [],
      warnings: [],
    }
    this.emit('changed', this.state, receipt)
    return receipt
  }

  get history(): { undo: string[]; redo: string[] } {
    return {
      undo: this.undoStack.map((e) => e.label),
      redo: this.redoStack.map((e) => e.label),
    }
  }

  markSaved(path: string): void {
    this.state = { ...this.state, path }
    this.dirty = false
    this.emit('saved', this.state)
  }
}

// --- Persistence ----------------------------------------------------------

/** A project is a folder: `Name.palmier/project.json` plus a thumbnail cache. */
export const PROJECT_FILE_NAME = 'project.json'
export const CACHE_DIR_NAME = 'cache'

export function cacheDirFor(projectPath: string | null): string {
  // An unsaved project still needs a real, writable cache directory.
  if (!projectPath) return join(tmpdir(), 'palmier-win-cache')
  return join(projectPath, CACHE_DIR_NAME)
}

/** Staged write then atomic rename, so a crash mid-save cannot truncate the project. */
export async function saveProject(project: Project, projectPath: string): Promise<Project> {
  await mkdir(join(projectPath, CACHE_DIR_NAME), { recursive: true })
  const saved: Project = { ...project, path: projectPath, modifiedAt: new Date().toISOString() }
  const payload: ProjectFile = { version: PROJECT_FILE_VERSION, project: saved }

  const target = join(projectPath, PROJECT_FILE_NAME)
  const staging = join(projectPath, `.${randomUUID()}.tmp`)
  await writeFile(staging, JSON.stringify(payload, null, 2), 'utf8')
  await rename(staging, target)
  return saved
}

/**
 * True when the folder actually holds a project. Checked before loading so a
 * wrong folder is refused by name rather than surfaced as a raw ENOENT.
 */
export async function isProjectFolder(folderPath: string): Promise<boolean> {
  try {
    await readFile(join(folderPath, PROJECT_FILE_NAME), 'utf8')
    return true
  } catch {
    return false
  }
}

export async function loadProject(projectPath: string): Promise<Project> {
  const target = projectPath.endsWith('.json') ? projectPath : join(projectPath, PROJECT_FILE_NAME)

  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch {
    throw new OpError(
      'not_a_project',
      `"${basename(projectPath)}" is not a Palmier project — it has no ${PROJECT_FILE_NAME}. ` +
        `Pick the .palmier folder itself, not the folder containing it.`,
    )
  }

  let parsed: ProjectFile
  try {
    parsed = JSON.parse(raw) as ProjectFile
  } catch (error) {
    throw new OpError('invalid_project', `${target} is not valid JSON: ${(error as Error).message}`)
  }
  if (parsed.version !== PROJECT_FILE_VERSION) {
    throw new OpError(
      'unsupported_version',
      `project file version ${parsed.version} is not supported (this build reads version ${PROJECT_FILE_VERSION})`,
    )
  }
  if (!parsed.project?.timelines?.length) {
    throw new OpError('invalid_project', `${target} contains no timeline`)
  }
  return {
    ...parsed.project,
    path: dirname(target),
    // Projects written before the work zone existed simply have none.
    timelines: parsed.project.timelines.map((t) => ({ ...t, workZone: t.workZone ?? null })),
  }
}
