# Palmier Win

An AI-native video editor for Windows. Agents edit the timeline directly over MCP — the
same timeline you see and drag clips on, with the same validation, the same undo history,
and honest receipts when an edit is refused.

Two lineages meet here. The agent-first idea comes from
[palmier-pro](https://github.com/palmier-io/palmier-pro), a macOS editor built on Swift,
SwiftUI, AVFoundation, Metal and Core Image. The working shape of the editor — menu bar,
project bin, dual monitors, effect stack, audio mixer, razor and spacer tools — follows
[Kdenlive](https://kdenlive.org), because that is the vocabulary editors already know.

Neither is ported. None of Apple's frameworks exist on Windows and no upstream code from
either project is reused, which is why this is Apache-2.0 rather than inheriting a copyleft
licence: TypeScript, Electron and FFmpeg, written from scratch.

## What works

- **Timeline editing** — multi-track video, audio and text; trim, retime, split, ripple
  delete, move across tracks, fades, opacity, transform, crop.
- **Tools** — selection, razor and spacer, with snapping to clip edges, markers and the
  playhead.
- **23 effects** in five categories (colour, blur/sharpen, distort, stylize, audio), each a
  stack entry that can be reordered, bypassed or removed.
- **11 transitions** — dissolve, fades through black and white, four wipes, two slides and
  two circles. The incoming clip is pulled back over its predecessor using its own head
  handle, so clip positions never move and removing a transition is lossless.
- **Keyframes** on opacity, volume, the five transform parameters and the effect
  parameters FFmpeg re-evaluates per frame, with linear, smooth and hold interpolation. A
  keyframe bar under the project monitor draws each curve; frames are stored relative to the
  clip, so moving a clip carries its animation. Anything FFmpeg would render as a constant is
  refused rather than silently accepted.
- **Grading** — a three-way colour corrector with draggable wheels for shadows, midtones and
  highlights, and tone curves for master, red, green and blue. A channel left straight costs no
  filter pass.
- **Subtitles** — import and export .srt and .vtt, edit the text in a panel, and retime cues on
  the timeline with the same trim and move as any other clip. They are burnt into the render.
- **Proxy clips** — one button transcodes every oversized video to a 640-wide all-intra copy
  so scrubbing stays responsive on a laptop. Preview and playback read the proxy; **an export
  always reads the original**, so this costs nothing in the delivered file.
- **Multicam** — pick several angles in the bin, and the offsets are measured from their audio
  before the clip is placed. Press 1-9 to cut to a camera at the playhead; the sound stays on the
  first angle. A cut is an ordinary cut, so the result is a timeline anyone can open and trim.
- **Track lock, mute, hide** and a per-track gain fader in a decibel-calibrated mixer.
- **Dual monitors** — the clip monitor shows raw source from the bin, the project monitor
  shows the composited edit.
- **Native menu** with real accelerators; every item routes to the same handler the UI
  buttons use, so there is no second implementation to drift.
- **MCP server** on `http://127.0.0.1:19789/mcp`, 46 tools, bound to loopback only.
- **Export** — H.264 / AAC MP4 with live progress and cancellation.
- **Built-in agent** — a conversation panel that edits through the same 46 tools the MCP
  server exposes, so its work lands on the same undo stack as yours. Needs your own Anthropic
  API key, which is encrypted with the OS keystore.
- **Action journal** — every edit with its source (you, the built-in agent, or an MCP client),
  and undo for any single entry: the state before it is restored and the later edits are
  re-run on top, with anything that no longer applies named rather than dropped in silence.
- **Undo/redo** shared by the UI and the agent: an agent's edit is undoable from the toolbar,
  and a UI edit is undoable from the `undo` tool.

## Architecture

```
src/core/        Pure domain. No Electron, no Node, no I/O — this is where correctness lives.
  model.ts       Timeline / Track / Clip. Frames are the source of truth; seconds only at boundaries.
  ops.ts         Every mutation. UI, MCP and tests all go through these functions.
  effects.ts     Effect registry: parameters, bounds, and the FFmpeg filter each becomes.
  keyframes.ts   Animation curves, interpolation, and the FFmpeg expression each compiles to.
  transitions.ts Transition rendering, resolved to alpha or geometry on the incoming clip.
  render.ts      Timeline -> FFmpeg argv. Pure, so the render graph is unit-testable without FFmpeg.
  timecode.ts    Frame <-> timecode conversion.

src/main/      Electron main process.
  project/store.ts  The single owner of mutable state: undo history, action journal, atomic save.
  media/ffmpeg.ts   Process management: probe, thumbnails, render, progress, cancellation.
  media/proxy.ts    Editing stand-ins: all-intra transcode, cache keyed by size and mtime.
  media/sync.ts     Multicam sync: loudness-envelope correlation, with a confidence.
  mcp/server.ts     JSON-RPC 2.0 over Streamable HTTP.
  mcp/tools.ts      The tool surface.
  agent/            The built-in agent: Anthropic client, tool loop, key storage.

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
`set_clip_properties` · `add_texts` · `update_text` · `list_animatable` · `set_keyframe` ·
`move_keyframe` · `remove_keyframe` · `trim_clip` · `group_clips` · `ungroup_clips` ·
`set_work_zone` · `sync_angles` · `create_multicam` · `switch_angle` · `build_proxies` ·
`get_subtitles` · `import_subtitles` · `export_subtitles` · `add_markers` · `capture_frame`
· `export_project` · `undo` · `list_effects` · `apply_effect` · `get_clip_effects` ·
`set_effect` · `set_effect_curve` · `remove_effect` · `reorder_effect` · `list_transitions`
· `add_transition` · `remove_transition`

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
npm test           # 321 tests: domain, keyframes, render graph, MCP, agent and FFmpeg end-to-end
npm run typecheck
```

`npm test` includes two end-to-end suites. One starts the real MCP server, drives it over
HTTP, renders with the real FFmpeg binary and reads the result back with `ffprobe`. The
other renders every one of the 21 effects and 11 transitions through FFmpeg, because
filter-graph expressions — especially the `geq` alpha maths behind wipes and circles —
cannot be proven correct by inspection. A success-shaped tool response is never accepted as
proof on its own.

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
CI sidesteps this entirely by building the Windows artifacts on a Windows runner.

## Releases

Pushing a tag builds both platforms and attaches the binaries to a GitHub release:

```bash
npm version patch        # or minor / major
git push --follow-tags
```

`.github/workflows/release.yml` runs the full suite first, then builds on `windows-latest`
and `ubuntu-latest` and publishes. `.github/workflows/ci.yml` runs the suite on every push.

The app checks for a newer release on startup and shows a notice in the status bar.
Downloading and restarting are two separate clicks, and an update refuses to install over an
unsaved project — an editor left open on an unsaved cut must never restart itself.

**Builds are not code-signed.** Windows SmartScreen warns on first run, and will keep doing so
until an Authenticode certificate is bought (roughly €300/year for an OV certificate, more for
EV). Everything else works unsigned, including updates.
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
- Effects have fixed parameters; there is no keyframe animation on them yet.
- Wipe and circle transitions evaluate `geq` per pixel per frame and render roughly five
  times slower than the fade-based kinds.
- Track order is composite order: track 0 is the bottom layer. Audio tracks therefore appear
  interleaved with video tracks in the header list rather than grouped below them.
- No keyframe animation, effects, colour grading, transcription or generative models. Those
  are large surfaces in the original and are not implemented here.

## Licence

Apache-2.0.
