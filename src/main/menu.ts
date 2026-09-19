/**
 * Native application menu.
 *
 * Menu items send a command to the renderer rather than mutating state here, so
 * a menu action and its keyboard shortcut take exactly the same path as clicking
 * the button — there is no second implementation to drift.
 */

import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export type MenuCommand =
  | 'project:new'
  | 'project:open'
  | 'project:save'
  | 'project:saveAs'
  | 'project:export'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:selectAll'
  | 'edit:deselect'
  | 'edit:delete'
  | 'edit:rippleDelete'
  | 'media:import'
  | 'timeline:split'
  | 'timeline:addText'
  | 'timeline:addMarker'
  | 'timeline:addVideoTrack'
  | 'timeline:addAudioTrack'
  | 'timeline:toggleSnap'
  | 'timeline:buildPreview'
  | 'timeline:zoomIn'
  | 'timeline:zoomOut'
  | 'timeline:zoomFit'
  | 'tool:select'
  | 'tool:razor'
  | 'tool:spacer'
  | 'view:effects'
  | 'view:mixer'
  | 'view:inspector'
  | 'playhead:start'
  | 'playhead:end'
  | 'help:mcp'

export function buildMenu(window: BrowserWindow): Menu {
  const send = (command: MenuCommand) => () => window.webContents.send('menu:command', command)

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: 'New project', accelerator: 'CmdOrCtrl+N', click: send('project:new') },
        { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: send('project:open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('project:save') },
        { label: 'Save as…', accelerator: 'CmdOrCtrl+Shift+S', click: send('project:saveAs') },
        { type: 'separator' },
        { label: 'Import media…', accelerator: 'CmdOrCtrl+I', click: send('media:import') },
        { label: 'Export video…', accelerator: 'CmdOrCtrl+E', click: send('project:export') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('edit:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('edit:redo') },
        { type: 'separator' },
        { label: 'Select all clips', accelerator: 'CmdOrCtrl+A', click: send('edit:selectAll') },
        { label: 'Deselect', accelerator: 'Escape', click: send('edit:deselect') },
        { type: 'separator' },
        { label: 'Delete', accelerator: 'Delete', click: send('edit:delete') },
        { label: 'Ripple delete', accelerator: 'Shift+Delete', click: send('edit:rippleDelete') },
      ],
    },
    {
      label: '&Timeline',
      submenu: [
        { label: 'Split at playhead', accelerator: 'S', click: send('timeline:split') },
        { label: 'Add text', accelerator: 'CmdOrCtrl+T', click: send('timeline:addText') },
        { label: 'Add marker', accelerator: 'M', click: send('timeline:addMarker') },
        { type: 'separator' },
        { label: 'Add video track', click: send('timeline:addVideoTrack') },
        { label: 'Add audio track', click: send('timeline:addAudioTrack') },
        { type: 'separator' },
        { label: 'Snap to edges', accelerator: 'N', click: send('timeline:toggleSnap') },
        { type: 'separator' },
        {
          label: 'Build timeline preview',
          accelerator: 'CmdOrCtrl+Shift+Return',
          click: send('timeline:buildPreview'),
        },
        { type: 'separator' },
        { label: 'Go to start', accelerator: 'Home', click: send('playhead:start') },
        { label: 'Go to end', accelerator: 'End', click: send('playhead:end') },
      ],
    },
    {
      label: 'T&ool',
      submenu: [
        { label: 'Selection', accelerator: 'V', click: send('tool:select') },
        { label: 'Razor', accelerator: 'X', click: send('tool:razor') },
        { label: 'Spacer', accelerator: 'B', click: send('tool:spacer') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Effects panel', accelerator: 'CmdOrCtrl+1', click: send('view:effects') },
        { label: 'Audio mixer', accelerator: 'CmdOrCtrl+2', click: send('view:mixer') },
        { label: 'Inspector', accelerator: 'CmdOrCtrl+3', click: send('view:inspector') },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: send('timeline:zoomIn') },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: send('timeline:zoomOut') },
        { label: 'Fit timeline', accelerator: 'CmdOrCtrl+0', click: send('timeline:zoomFit') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Connect an agent over MCP', click: send('help:mcp') },
        {
          label: 'Project on GitHub',
          click: () => void shell.openExternal('https://github.com/LabbeSimon/palmier-pro-windows'),
        },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}
