# Studio — Screen Recorder with Auto Zoom

A Screen Studio-style desktop screen recorder: automatic zoom on your clicks, smooth enhanced cursor, click ripples, styled backgrounds, webcam bubble, full-screen camera moments, cuts, voice enhancement, and MP4/WebM/GIF export.

Works on **macOS and Windows** (Linux too). On Windows: double-click `Start Studio.bat`, hotkey is Ctrl+Shift+S, no screen-recording permission dance needed. Build a Windows installer with `npm run dist:win`.

## Run it

Requires Node.js 18+ (https://nodejs.org).

**Easiest:** double-click `Start Studio.command` in Finder. (First time, macOS may block it — right-click it → Open → Open. It installs dependencies on first run, then launches the app.)

Or from a terminal:

```bash
cd screen-studio-app
npm install
npm start
```

**Make a real macOS app (.dmg / Studio.app):**

```bash
npm run dist
```

The installable app appears in the `dist/` folder — drag Studio.app to Applications and launch it like any other app from then on (no terminal, no Node needed).

## macOS permissions (first run)

1. **Screen Recording** — macOS will prompt when you start your first recording. Grant it to Electron (or Studio) in System Settings › Privacy & Security › Screen Recording, then restart the app.
2. **Accessibility** — needed for global click detection (the input for auto-zoom). Grant it in System Settings › Privacy & Security › Accessibility. Without it, the app still works and generates zooms from cursor pauses instead of clicks.

## How to use

1. Pick a screen, optionally toggle webcam/mic, hit **Start Recording**. The window minimizes after a 3-2-1 countdown.
2. Do your demo. Stop with **⌘⇧S** (Ctrl+Shift+S) or from the app window.
3. The editor opens with zoom moments auto-generated from your clicks (purple blocks on the timeline):
   - Click a block to remove it; **+ Add at playhead** inserts one; **↻ Regenerate** rebuilds them after changing the zoom level.
   - Style with backgrounds, padding, corner radius, shadow; adjust enhanced cursor size/smoothing; position the webcam bubble; trim with the handles.
4. Timeline lanes (top→bottom): zoom (purple) · full-screen camera (green) · overlays (blue slide / yellow annotation / orange image / pink video clip) · masks (gray) · cuts (red). All blocks: drag to move, drag edges to resize, double-click to remove, single-click to edit text or select a mask. The audio waveform is drawn along the bottom.
   - **Overlays**: full-frame text slides, draggable annotation labels, image/screenshot inserts, and B-roll video clips — all with enter/exit animations (fade / slide / scale).
   - **Masking**: pixelate sensitive areas; masks track your zooms. Drag the patch on the preview to place it.
   - **Shareable links**: after exporting, "Copy shareable link" uploads the file to 0x0.st (anonymous host, ~30-day retention) and copies the URL.
   - **Open a video file…** on the start screen turns any pre-recorded video into a project (all editing features except cursor effects).
5. Pick which camera/microphone to use with the dropdowns that appear on the start screen; the live preview and waveform confirm they work.
6. Export as MP4, WebM, or GIF (GIF export fetches its encoder from a CDN, so it needs internet once). "Enhance voice" applies a studio-style EQ + compressor to your mic audio; "Also save webcam clip" downloads the raw camera recording as a separate file for editing elsewhere.

## Troubleshooting: "No screen source found" / permission needed

macOS blocks screen capture until you grant permission, and **requires an app restart after granting**:

1. Open System Settings › Privacy & Security › **Screen Recording** (the app now shows a button that takes you there).
2. Enable **Electron** (or Studio if you built the packaged app).
3. Quit the app completely and reopen it. Your screens will now appear.

## Open source

The project is MIT-licensed (see `LICENSE`) — ready to publish. To put it on GitHub:

```bash
cd screen-studio-app
git init && git add . && git commit -m "Initial commit"
gh repo create studio-recorder --public --source=. --push
```

(or create an empty repo on github.com and `git remote add origin … && git push`). Add screenshots or an exported GIF to this README — a demo GIF made with the app itself is the best pitch.

## Notes

- **Screen recordings** hide the real system cursor in the capture and draw the smooth enhanced cursor instead (no overlap). Auto-zoom from clicks/cursor works fully.
- **Window recordings** keep the real cursor and have no cursor coordinate data — add zooms manually with *+ Add at playhead*, then double-click the preview to aim them.
- Zoom blocks on the timeline: drag to move, drag the edges to stretch/shorten, double-click to remove.
- Windows/Linux work too; hotkey is Ctrl+Shift+S.
- Mic audio is recorded; system audio capture isn't supported on macOS without a virtual audio driver (e.g., BlackHole).
