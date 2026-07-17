# Focal — the app

This is the Electron app itself. See the [repo root README](../README.md) for
an overview, downloads, and the landing site.

## Run it

```bash
npm install
npm start
```

Or double-click `Start Studio.command` (macOS) / `Start Studio.bat`
(Windows) — both install dependencies on first run, then launch the app.

## Build a distributable

```bash
npm run dist        # macOS .dmg / .zip → dist/
npm run dist:win    # Windows installer → dist/
```

Drag the built `.app` to Applications (macOS) or run the installer
(Windows) — no terminal or Node needed after that.

## How it works

1. Pick a screen or window, optionally toggle webcam/mic, hit **Start
   Recording**. The window minimizes after a 3-2-1 countdown.
2. Do your demo. Stop with **⌘⇧S** (Ctrl+Shift+S) or from the app window.
3. The editor opens with zoom moments auto-generated from your clicks
   (purple blocks on the timeline). Click a block to remove it; **+ Add at
   playhead** inserts one; **↻ Regenerate** rebuilds them after changing the
   zoom level.
4. Style backgrounds, padding, corner radius, shadow; adjust the enhanced
   cursor; position the webcam bubble; add overlays/masks; trim with the
   timeline handles.
5. Export as MP4, WebM, or GIF. "Enhance voice" applies EQ + compression to
   the mic track; "Copy shareable link" uploads and returns a URL.

Full walkthrough: https://focal-app.pages.dev/docs

## macOS capture architecture

Full-screen and per-window recording both go through a native Swift helper
(`native/capture.swift`, compiled to `native/focal_capture`) built on
ScreenCaptureKit + AVAssetWriter, spawned as a child process by `main.js`.
It reports authoritative `DIMENSIONS`, `OWNER`, and `WINDOWFRAME` values over
stdout, which the renderer uses to map tracked cursor/click samples (from an
AppleScript/System Events poller) onto the exact captured frame — this
avoids reconciling two independently-measured coordinate systems with
heuristics.

To rebuild the helper after editing `capture.swift`:

```bash
cd native
swiftc capture.swift -o focal_capture -framework ScreenCaptureKit -framework AVFoundation -framework CoreImage
```

## Notes

- Windows/Linux: hotkey is Ctrl+Shift+S; window-recording cursor tracking is
  macOS-only for now (native capture is a macOS/ScreenCaptureKit feature).
- Mic audio is recorded; system audio capture isn't supported on macOS
  without a virtual audio driver (e.g., BlackHole).
