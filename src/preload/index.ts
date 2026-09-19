import { contextBridge, ipcRenderer } from 'electron'

import type { Project } from '../core/model.js'
import type { Receipt } from '../core/ops.js'

export interface Snapshot {
  project: Project
  dirty: boolean
  history: { undo: string[]; redo: string[] }
  mcp: { running: boolean; endpoint: string | null; error: string | null }
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; details?: string }

export interface RenderProgress {
  frame: number
  totalFrames: number
  fps: number
  speed: string
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: unknown, payload: T) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  project: {
    snapshot: () => invoke<Snapshot>('project:snapshot'),
    create: () => invoke<Snapshot>('project:new'),
    open: (path?: string) => invoke<Snapshot>('project:open', path),
    save: (saveAs?: boolean) => invoke<Snapshot>('project:save', saveAs),
    undo: () => invoke<Snapshot>('project:undo'),
    redo: () => invoke<Snapshot>('project:redo'),
    onChanged: (listener: (payload: { project: Project; receipt: Receipt }) => void) =>
      subscribe('project:changed', listener),
  },
  ops: {
    addClips: (args: unknown) => invoke<Receipt>('ops:addClips', args),
    removeClips: (args: unknown) => invoke<Receipt>('ops:removeClips', args),
    splitClips: (args: unknown) => invoke<Receipt>('ops:splitClips', args),
    moveClips: (args: unknown) => invoke<Receipt>('ops:moveClips', args),
    setClipProperties: (args: unknown) => invoke<Receipt>('ops:setClipProperties', args),
    addTexts: (args: unknown) => invoke<Receipt>('ops:addTexts', args),
    updateText: (args: unknown) => invoke<Receipt>('ops:updateText', args),
    addTrack: (args: unknown) => invoke<Receipt>('ops:addTrack', args),
    removeTrack: (args: unknown) => invoke<Receipt>('ops:removeTrack', args),
    setTrackFlags: (args: unknown) => invoke<Receipt>('ops:setTrackFlags', args),
    addMarkers: (args: unknown) => invoke<Receipt>('ops:addMarkers', args),
    createTimeline: (args: unknown) => invoke<Receipt>('ops:createTimeline', args),
    setActiveTimeline: (args: unknown) => invoke<Receipt>('ops:setActiveTimeline', args),
    setProjectSettings: (args: unknown) => invoke<Receipt>('ops:setProjectSettings', args),
    removeAssets: (args: unknown) => invoke<Receipt>('ops:removeAssets', args),
  },
  media: {
    import: (paths?: string[]) => invoke<Receipt>('media:import', paths),
    readImage: (path: string) => invoke<string>('media:readImage', path),
    onThumbnail: (listener: (payload: { assetId: string; thumbnailPath: string }) => void) =>
      subscribe('media:thumbnail', listener),
  },
  render: {
    frame: (frame: number) => invoke<string>('render:frame', frame),
    export: (args: { outputPath?: string; quality?: 'draft' | 'balanced' | 'high' }) =>
      invoke<{ cancelled: boolean; outputPath?: string }>('render:export', args),
    cancel: () => invoke<{ cancelled: boolean }>('render:cancel'),
    onProgress: (listener: (progress: RenderProgress) => void) => subscribe('render:progress', listener),
  },
  system: {
    info: () => invoke<{ ffmpeg: string; electron: string; node: string }>('system:info'),
    reveal: (path: string) => invoke<boolean>('shell:reveal', path),
    onMcpStatus: (listener: (status: Snapshot['mcp']) => void) => subscribe('mcp:status', listener),
  },
}

export type PalmierApi = typeof api

contextBridge.exposeInMainWorld('palmier', api)
