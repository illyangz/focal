# Focal

Beautiful screen recordings with automatic zoom. Focal watches your clicks while
you record and generates smooth, cinematic zoom-ins automatically — no manual
keyframing. Record a full screen (with optional crop-to-area), a single window,
or a webcam, then edit and export from a built-in timeline editor.

**Website & downloads:** https://focal-app.pages.dev
**Docs:** https://focal-app.pages.dev/docs

## Features

- Automatic click-driven zoom, no manual keyframing
- Native macOS capture (ScreenCaptureKit) for both full-screen and per-window
  recording, with accurate cursor tracking on both
- Custom-area/crop recording for full-screen captures (set once, at the start)
- Smooth vector cursor redraw with click ripples and adjustable size/smoothing
- Webcam bubble, full-screen camera moments, text/image/video overlays
- Masking (blur/pixelate) that tracks zoom automatically
- In-app theme picker (6 accent colors, remembered across launches)
- First-run guided tour + in-context help on both the setup and editor screens
- Export to MP4 / WebM / GIF, with optional voice enhancement

## Repo layout

```
screen-studio-app/   The Electron app (main process, renderer/editor UI, native
                      Swift capture helper). This is Focal itself.
landing/              Marketing site + docs, deployed to Cloudflare Pages.
```

## Running Focal from source

Requires [Node.js](https://nodejs.org) 18+. macOS also needs Xcode Command Line
Tools (`xcode-select --install`) if you need to rebuild the native capture
helper.

```bash
cd screen-studio-app
npm install
npm start
```

On macOS you can also double-click `Start Studio.command`; on Windows,
`Start Studio.bat`. Both install dependencies on first run.

### macOS permissions

Focal needs two permissions, granted via the native OS prompts on first use:

- **Screen Recording** — required to capture anything. System Settings ›
  Privacy & Security › Screen Recording.
- **Accessibility** — required for click-driven auto-zoom on window
  recordings. System Settings › Privacy & Security › Accessibility. Without
  it, zooms are generated from cursor pauses instead of clicks.

macOS requires an app restart after granting either permission.

### Building a distributable

```bash
cd screen-studio-app
npm run dist        # macOS .dmg / .zip
npm run dist:win    # Windows installer (cross-compiles from macOS via Wine)
```

Output lands in `screen-studio-app/dist/`.

The native capture helper (`native/focal_capture`) is a prebuilt binary
compiled from `native/capture.swift`. To rebuild it on macOS:

```bash
cd screen-studio-app/native
swiftc -parse-as-library capture.swift -o focal_capture -framework ScreenCaptureKit -framework AVFoundation -framework CoreImage
```

## Landing site

Static HTML/CSS/JS in `landing/`, deployed to Cloudflare Pages:

```bash
npx wrangler pages deploy landing/ --project-name focal-app
```

Downloadable installers are hosted on Cloudflare R2 (bucket `focal-downloads`),
not in this repo or on Pages — keep new builds in sync there with
`wrangler r2 object put`.

## License

Proprietary — see [LICENSE](LICENSE). All rights reserved.
