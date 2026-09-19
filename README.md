# Palmier Win

An AI-native video editor for Windows. Agents edit the timeline directly over MCP — the
same timeline you see and drag clips on, with the same validation, the same undo history,
and honest receipts when an edit is refused.

Inspired by [palmier-pro](https://github.com/palmier-io/palmier-pro), a macOS editor built
on Swift, SwiftUI, AVFoundation, Metal and Core Image. None of those frameworks exist on
Windows, so this is an independent implementation of the idea rather than a port: TypeScript,
Electron and FFmpeg. No upstream code is reused, which is why this project is Apache-2.0
rather than inheriting the original's GPLv3.

## What works

- **Timeline editing** — multi-track video, audio and text; trim, retime, split, ripple
  delete, move across tracks, fades, opacity, transform, crop.
- **MCP server** on `http://127.0.0.1:19789/mcp`, 21 tools, bound to loopback only.
- **Preview** — every frame is composited by FFmpeg, so what you see is what exports.
- **Export** — H.264 / AAC MP4 with live progress and cancellation.
- **Undo/redo** shared by the UI and the agent: an agent's edit is undoable from the toolbar,
  and a UI edit is undoable from the `undo` tool.

## Architecture

```
src/core/      Pure domain. No Electron, no Node, no I/O — this is where correctness lives.
  model.ts     Timeline / Track / Clip. Frames are the source of truth; seconds only at boundaries.
  ops.ts       Every mutation. UI, MCP and tests all go through these functions.
  render.ts    Timeline -> FFmpeg argv. Pure, so the render graph is unit-testable without FFmpeg.
  timecode.ts  Frame <-> timecode conversion.

src/main/      Electron main process.
  project/store.ts  The single owner of mutable state, plus undo history and atomic save.
  media/ffmpeg.ts   Process management: probe, thumbnails, render, progress, cancellation.
  mcp/server.ts     JSON-RPC 2.0 over Streamable HTTP.
  mcp/tools.ts      The tool surface.

src/renderer/  React UI. Holds a read-only mirror of the store and mutates only through IPC.
```

Two rules hold the design together:

1. **One owner for mutable state.** The renderer never edits the project; it sends an
   operation and re-reads the result. An agent editing over MCP therefore shows up live in
   the UI, with no divergence possible.
2. **One implementation per domain rule.** Placement, collision, trimming and clamping live
   in `src/core/ops.ts` only. A tool and a drag gesture cannot disagree about what is legal.

## Tool surface

`get_timeline` · `inspect_timeline` · `get_media` · `search_media` · `import_media` ·
`create_timeline` · `set_active_timeline` · `set_project_settings` · `add_track` ·
`set_track_flags` · `add_clips` · `remove_clips` · `split_clips` · `move_clips` ·
`set_clip_properties` · `add_texts` · `update_text` · `add_markers` · `capture_frame` ·
`export_project` · `undo`

Tools refuse rather than improvise. An overlapping placement, a duration the media cannot
supply, or a fade longer than its clip returns an actionable error and changes nothing —
it is never silently retargeted. Unchanged operations report `changed: false` instead of a
success-shaped response, and they do not create an undo step.

### Connecting an agent

```json
{
  "mcpServers": {
    "palmier": { "type": "http", "url": "http://127.0.0.1:19789/mcp" }
  }
}
```

`GET /health` reports readiness without a handshake. Set `PALMIER_MCP_PORT` to move the port.

## Development

```bash
npm install
npm run dev        # Electron with HMR on the renderer
npm test           # 70 tests: domain, render graph, timecode, and MCP end-to-end
npm run typecheck
```

`npm test` includes an end-to-end suite that starts the real MCP server, drives it over
HTTP, renders with the real FFmpeg binary and reads the result back with `ffprobe`. A
success-shaped tool response is never accepted as proof on its own.

FFmpeg resolution, most specific first: `PALMIER_FFMPEG` / `PALMIER_FFPROBE`, then the
packaged app's resources, then `resources/ffmpeg/<platform>-<arch>/`, then `PATH`. On Linux
development machines the system FFmpeg is used with no setup.

## Packaging for Linux

```bash
npm run package:linux          # dist/*.AppImage + dist/*.deb
```

Nothing is Windows-specific in the app itself, so the Linux targets build natively with no
Wine and no caveats. Each platform ships its own FFmpeg via `linux.extraResources` /
`win.extraResources`, so a build never carries the other platform's binaries.

## Packaging for Windows

```bash
npm run package:win:zip        # dist/*-x64.zip — no Wine needed
npm run package:win            # dist/*-setup.exe + dist/*-portable.exe — needs Wine
```

This downloads a current official Windows FFmpeg build into `resources/ffmpeg/win32-x64/`
and ships it as an extra resource. The common `@ffmpeg-installer/ffmpeg` package is
deliberately not used: it is pinned to a 2018 build that lacks filter options this render
graph relies on.

**Cross-building from Linux needs Wine for the `.exe` targets.** Only `zip` builds without
it — the NSIS installer *and* the single-file portable both wrap the app in an NSIS stub.
The zip contains the same working `Palmier Win.exe`; unzip anywhere and run it.

Two traps when installing Wine on Debian/Ubuntu:

- The `wine64` package installs `/usr/bin/wine64` but **no `wine`**, and electron-builder
  looks for `wine` by name. Symlink it: `ln -sf /usr/bin/wine64 /usr/local/bin/wine`.
  Wine 9+ runs the 32-bit NSIS stub through its built-in WoW64, so no i386 packages are needed.
- `fpm` and the NSIS stage stage hundreds of MB through `TMPDIR`. If `/tmp` is a small
  tmpfs the build dies with `Disk quota exceeded`; point `TMPDIR` at real disk.

The Linux build also sets `win.signAndEditExecutable: false`, without which electron-builder
invokes `signtool.exe` through Wine even with no certificate. The cost is that the produced
`.exe` carries the default Electron icon and no version metadata. Build on Windows, or
install Wine, for a release-grade artefact — and note that an unsigned `.exe` triggers a
SmartScreen warning either way.

## Known limits

- Media is referenced by absolute path, not copied into the project folder. Moving a source
  file breaks the clips that use it.
- Playback is frame-by-frame scrubbing through FFmpeg, not realtime playback.
- Track order is composite order: track 0 is the bottom layer. Audio tracks therefore appear
  interleaved with video tracks in the header list rather than grouped below them.
- No keyframe animation, effects, colour grading, transcription or generative models. Those
  are large surfaces in the original and are not implemented here.

## Licence

Apache-2.0.
