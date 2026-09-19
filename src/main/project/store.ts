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

export interface UndoEntry {
  project: Project
  label: string
}

export class ProjectStore extends EventEmitter {
  private state: Project
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private dirty = false

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

  /**
   * Runs a domain operation. A refused or unchanged operation leaves the undo
   * history untouched, so undo never swallows a no-op step.
   */
  apply(operation: (project: Project) => MutationResult): Receipt {
    const before = this.state
    const result = operation(before)
    if (!result.receipt.changed) return result.receipt

    this.undoStack.push({ project: before, label: result.receipt.summary })
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift()
    this.redoStack = []
    this.state = result.project
    this.dirty = true
    this.emit('changed', this.state, result.receipt)
    return result.receipt
  }

  /** Replaces state without an undo entry — for load and new-project only. */
  replace(project: Project): void {
    this.state = project
    this.undoStack = []
    this.redoStack = []
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
  return { ...parsed.project, path: dirname(target) }
}
