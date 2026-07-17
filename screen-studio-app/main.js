const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, systemPreferences, shell, session, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");

// Sets the name shown in the Dock, Cmd+Tab switcher, and menu bar — must be
// called before the app is ready. electron-builder uses `productName` for the
// packaged app instead; this covers running unpackaged via `npm start`.
app.setName("Focal");

// Global click detection (optional — needs Accessibility permission on macOS).
// If unavailable, the renderer falls back to dwell-based zoom detection.
let uIOhook = null;
try {
  ({ uIOhook } = require("uiohook-napi"));
} catch (e) {
  console.log("[studio] uiohook-napi not available — using dwell-based auto-zoom fallback.");
}

// Active-window bounds tracking (macOS only) — lets window recordings map
// global cursor coordinates into the recorded window's space. Uses
// `osascript`/System Events (a signed Apple binary) instead of a bundled
// helper binary: spawning our own unsigned helper would need its own,
// separately-granted Accessibility trust (macOS gates it per-executable),
// which is a confusing extra step users would have to hunt for in System
// Settings. Automating System Events instead prompts once, natively, the
// first time it's used (System Settings › Privacy & Security › Automation).
const AS_FRONT_WINDOW = [
  "-e", 'tell application "System Events"',
  "-e", "set frontProc to first application process whose frontmost is true",
  "-e", "set procName to name of frontProc",
  "-e", "set winList to windows of frontProc",
  "-e", "if (count of winList) is 0 then",
  "-e", 'return "" & "|" & "" & "|" & "" & "|" & "" & "|" & "" & "|" & procName',
  "-e", "end if",
  // "front window" is fragile for apps that throw up lots of transient
  // popups/palettes (command palettes, autocomplete, hover docs — exactly
  // what a code editor does constantly): it can return whichever tiny popup
  // happens to be frontmost at that instant instead of the actual main
  // window, which then makes cursor-position math blow up completely
  // (dividing by a near-zero width/height). Picking the largest window of
  // the process instead is far more reliably "the window being recorded".
  "-e", "set bestW to item 1 of winList",
  "-e", "set bestArea to 0",
  "-e", "repeat with w in winList",
  "-e", "set {sizeW, sizeH} to size of w",
  "-e", "set thisArea to sizeW * sizeH",
  "-e", "if thisArea > bestArea then",
  "-e", "set bestArea to thisArea",
  "-e", "set bestW to w",
  "-e", "end if",
  "-e", "end repeat",
  "-e", "set {posX, posY} to position of bestW",
  "-e", "set {sizeW, sizeH} to size of bestW",
  "-e", 'set wTitle to ""',
  "-e", "try",
  "-e", "set wTitle to name of bestW",
  "-e", "end try",
  "-e", 'return (posX as string) & "|" & (posY as string) & "|" & (sizeW as string) & "|" & (sizeH as string) & "|" & wTitle & "|" & procName',
  "-e", "end tell",
];

function parseWindowBoundsOutput(stdout) {
  // Shared by both platform samplers — same "x|y|w|h|title|owner" shape.
  // Title (and in principle owner name) could themselves contain "|" — the
  // last field is always the owner, everything between the fixed numeric
  // fields and that last field is the title, rejoined.
  const parts = String(stdout).trim().split("|");
  if (parts.length < 5) return null;
  const [xs, ys, ws, hs] = parts;
  const owner = parts[parts.length - 1];
  const title = parts.slice(4, parts.length - 1).join("|");
  const x = parseFloat(xs), y = parseFloat(ys), width = parseFloat(ws), height = parseFloat(hs);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height, title, owner: owner || "" };
}

function getFrontWindowBounds() {
  return new Promise((resolve) => {
    execFile("osascript", AS_FRONT_WINDOW, { timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseWindowBoundsOutput(stdout));
    });
  });
}

// Windows equivalent of the AppleScript sampler above — same purpose (map
// global cursor coordinates into the recorded window's space for windowed
// recordings), same "x|y|w|h|title|owner" output shape, so the renderer's
// existing matching/heuristic-offset logic needs no changes to consume it.
// Uses DwmGetWindowAttribute's EXTENDED_FRAME_BOUNDS rather than plain
// GetWindowRect — modern Windows pads GetWindowRect with an invisible resize
// border that isn't part of what's actually captured, which would otherwise
// reintroduce the same kind of offset bug the macOS chromeTop saga was about.
// SetProcessDpiAwarenessContext keeps these pixel coordinates in the same
// space as Electron's screen.getCursorScreenPoint().
//
// Runs as a single persistent process for the whole recording (spawned in
// track-start, killed in track-stop) rather than a fresh powershell.exe per
// sample — window bounds alone were fine sampled every 500ms via a fresh
// spawn, but cursor-shape tracking needs a much tighter interval than a
// per-tick process spawn could keep up with, so both are now reported by
// one long-lived loop, mirroring how the macOS native-capture helper streams
// lines over stdout for the life of the recording instead of being polled.
// [Console]::SetOut to an autoflushing StreamWriter is required here —
// PowerShell buffers stdout when it isn't attached to a real console, which
// would otherwise delay Node from seeing lines until the process exits.
const PS_STREAM_SAMPLER = `
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput())
$stdout.AutoFlush = $true
[Console]::SetOut($stdout)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FocalWin32 {
  public struct RECT { public int Left, Top, Right, Bottom; }
  public struct POINT { public int X, Y; }
  public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(out CURSORINFO pci);
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr hInstance, int lpCursorName);
}
"@
try { [FocalWin32]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null } catch {}

# Standard IDC_* system cursor IDs, mapped to Focal's cross-platform shape
# vocabulary (same names the macOS sampler reports) — Windows has no exact
# equivalent of a "closed hand" cursor, IDC_SIZEALL (4-way move) is the
# closest conceptual match, mapped to "grab".
$cursorMap = @{}
$cursorMap[[FocalWin32]::LoadCursor([IntPtr]::Zero, 32649)] = "pointer"    # IDC_HAND
$cursorMap[[FocalWin32]::LoadCursor([IntPtr]::Zero, 32513)] = "text"      # IDC_IBEAM
$cursorMap[[FocalWin32]::LoadCursor([IntPtr]::Zero, 32644)] = "resize-h"  # IDC_SIZEWE
$cursorMap[[FocalWin32]::LoadCursor([IntPtr]::Zero, 32645)] = "resize-v"  # IDC_SIZENS
$cursorMap[[FocalWin32]::LoadCursor([IntPtr]::Zero, 32646)] = "grab"      # IDC_SIZEALL
$cursorMap[[FocalWin32]::LoadCursor([IntPtr]::Zero, 32515)] = "crosshair" # IDC_CROSS
$cursorMap[[FocalWin32]::LoadCursor([IntPtr]::Zero, 32648)] = "not-allowed" # IDC_NO

$lastShape = ""
$counter = 0
while ($true) {
  $ci = New-Object FocalWin32+CURSORINFO
  $ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]"FocalWin32+CURSORINFO")
  $shape = "arrow"
  if ([FocalWin32]::GetCursorInfo([ref]$ci)) {
    if ($cursorMap.ContainsKey($ci.hCursor)) { $shape = $cursorMap[$ci.hCursor] }
  }
  if ($shape -ne $lastShape) {
    $lastShape = $shape
    Write-Output "CURSORSHAPE $shape"
  }

  $counter++
  if ($counter % 12 -eq 0) {
    $hwnd = [FocalWin32]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) {
      Write-Output "WINBOUNDS |||||"
    } else {
      $rect = New-Object FocalWin32+RECT
      $hr = [FocalWin32]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, [System.Runtime.InteropServices.Marshal]::SizeOf([type]"FocalWin32+RECT"))
      if ($hr -ne 0) { [FocalWin32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null }
      $sb = New-Object System.Text.StringBuilder(256)
      [FocalWin32]::GetWindowText($hwnd, $sb, 256) | Out-Null
      [uint32]$procId = 0
      [FocalWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
      $owner = ""
      try { $owner = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
      $w = $rect.Right - $rect.Left
      $h = $rect.Bottom - $rect.Top
      Write-Output ("WINBOUNDS {0}|{1}|{2}|{3}|{4}|{5}" -f $rect.Left, $rect.Top, $w, $h, $sb.ToString(), $owner)
    }
  }

  Start-Sleep -Milliseconds 40
}
`;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#0c0c0f",
    title: "Focal",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The custom-area recorder redraws a <canvas> every frame for the whole
      // recording via requestAnimationFrame — but the window is minimized
      // during recording, and Chromium throttles rAF/timers hard for
      // occluded/minimized windows by default, which stalls that redraw loop
      // almost immediately and truncates the captured video to ~1s. Regular
      // full-screen/window recording doesn't need this since it streams
      // frames straight from the OS capture, with no renderer redraw loop.
      backgroundThrottling: false,
    },
  });
  win.loadFile("renderer.html");
}

let selectedSourceId = null;
ipcMain.on("select-source", (e, id) => { selectedSourceId = id; });

/* ---------- Auto-update ----------
 * Feed is hosted on the same R2 bucket the installers already live in
 * (electron-builder's "generic" provider — see package.json's build.publish).
 * Windows gets the full silent download + "restart to install" flow, since
 * that works fine even unsigned. macOS is intentionally lighter: Squirrel.Mac
 * (what electron-updater uses under the hood to apply mac updates) validates
 * that the old and new app's code signatures match before it'll self-replace
 * the bundle — Focal isn't signed yet, so attempting that would just fail.
 * Checking for an update and pointing the user at a manual download instead
 * needs no signature validation at all, so it stays reliable either way.
 */
autoUpdater.autoDownload = process.platform === "win32";
autoUpdater.autoInstallOnAppQuit = process.platform === "win32";

autoUpdater.on("update-available", (info) => {
  if (process.platform !== "darwin") return; // Windows: autoDownload handles it silently
  dialog.showMessageBox(win || undefined, {
    type: "info",
    title: "Update available",
    message: `Focal ${info.version} is available — you have ${app.getVersion()}.`,
    detail: "Focal isn't code-signed yet, so updates on macOS need a quick manual download.",
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) shell.openExternal("https://focal-app.pages.dev");
  }).catch(() => {});
});

autoUpdater.on("update-downloaded", () => {
  if (process.platform !== "win32") return; // mac never auto-downloads, see above
  dialog.showMessageBox(win || undefined, {
    type: "info",
    title: "Update ready",
    message: "A new version of Focal has been downloaded.",
    detail: "Restart now to install it?",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) autoUpdater.quitAndInstall();
  }).catch(() => {});
});

autoUpdater.on("error", (err) => {
  console.log("[focal] auto-update check failed:", err.message);
});

function checkForUpdatesQuietly() {
  if (!app.isPackaged) return; // no publish feed to hit when running via `npm start`
  autoUpdater.checkForUpdates().catch(() => {});
}

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    try { app.dock.setIcon(path.join(__dirname, "build", "icon.png")); } catch {}
    // Ask the OS directly for Accessibility trust (native "would like to control
    // this computer" dialog) instead of silently failing when uiohook/active-win
    // can't start. `true` makes macOS prompt if not already granted.
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch {}
  }
  // Serve the source the renderer picked when it calls getDisplayMedia
  // (lets us use the modern API, which supports hiding the system cursor).
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      const src = sources.find((s) => s.id === selectedSourceId) || sources[0];
      callback({ video: src, audio: false });
    } catch (e) {
      callback({});
    }
  });
  createWindow();
  // Stop-recording hotkey (works while other apps are focused)
  globalShortcut.register("CommandOrControl+Shift+S", () => {
    if (win) {
      win.webContents.send("hotkey-stop");
    }
  });
  checkForUpdatesQuietly();
  setInterval(checkForUpdatesQuietly, 4 * 60 * 60 * 1000); // re-check every 4h for long-lived sessions
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (uIOhook && hookStarted) {
    try { uIOhook.stop(); } catch {}
  }
  if (camPreviewWin && !camPreviewWin.isDestroyed()) camPreviewWin.close();
});

/* ---------- Permissions ---------- */
ipcMain.handle("screen-perm", () => {
  // 'granted' | 'denied' | 'restricted' | 'not-determined' (always 'granted' on Win/Linux)
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("screen");
});
ipcMain.on("open-screen-settings", () => {
  if (process.platform === "darwin") {
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  }
});

/* ---------- Screen sources ---------- */
ipcMain.handle("get-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 420, height: 260 },
  });
  const displays = screen.getAllDisplays();
  return sources
    .filter((s) => s.name !== "Focal") // don't offer our own window
    .map((s) => {
      const isScreen = s.id.startsWith("screen");
      const d = isScreen
        ? displays.find((d) => String(d.id) === String(s.display_id)) || screen.getPrimaryDisplay()
        : null;
      return {
        id: s.id,
        name: s.name,
        kind: isScreen ? "screen" : "window",
        thumbnail: s.thumbnail.toDataURL(),
        bounds: d ? d.bounds : null, // DIP coordinates — same space as getCursorScreenPoint()
        scaleFactor: d ? d.scaleFactor : 1,
      };
    });
});

/* ---------- Custom-area selection (crop a screen recording) ---------- */
// Shows a full-display, click-drag overlay so the user can pick a sub-region
// of a display before recording starts (must be set up front — see renderer's
// crop pipeline, which re-draws captured frames into that rect live).
ipcMain.handle("select-region", (e, bounds) => {
  return new Promise((resolve) => {
    let settled = false;
    const ov = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false, transparent: true, hasShadow: false, resizable: false,
      movable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
      focusable: true, backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    ov.setAlwaysOnTop(true, "screen-saver");
    try { ov.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
    ov.loadFile("overlay.html");
    ov.once("ready-to-show", () => ov.show());

    const cleanup = () => {
      ipcMain.removeListener("overlay-done", onDone);
      ipcMain.removeListener("overlay-cancel", onCancel);
    };
    const finish = (rect) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!ov.isDestroyed()) ov.close();
      resolve(rect);
    };
    const onDone = (ev, rect) => {
      if (ev.sender !== ov.webContents) return;
      finish({
        x: Math.round(bounds.x + rect.x),
        y: Math.round(bounds.y + rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    const onCancel = (ev) => {
      if (ev.sender !== ov.webContents) return;
      finish(null);
    };
    ipcMain.on("overlay-done", onDone);
    ipcMain.on("overlay-cancel", onCancel);
    ov.on("closed", () => finish(null));
  });
});

/* ---------- Cursor & click tracking ---------- */
let events = [];
let pollTimer = null;
let lastPos = { x: 0, y: 0 };
let tracking = false;
let hookStarted = false;

function onMouseDown() {
  if (!tracking) return;
  // Use Date.now() to stay in the same time base as cursor movement events.
  // Position comes from the last poll — the 16ms max latency is acceptable
  // since click targeting has inherent tolerance.
  events.push({ t: Date.now(), x: lastPos.x, y: lastPos.y, c: 1 });
}

ipcMain.handle("win-tracking", () => process.platform === "darwin");

let winSamples = [];
let winTimer = null;
// Cursor-shape samples ({t, shape}), populated on macOS from the native
// capture helper's stdout (see native-capture-start below) and on Windows
// from winSamplerProc — plumbing only for now, the renderer doesn't draw
// shape-specific art yet, just records which shape was active when.
let shapeEvents = [];
let winSamplerProc = null; // Windows: persistent PowerShell sampler (window bounds + cursor shape)

ipcMain.handle("track-start", () => {
  events = [];
  winSamples = [];
  shapeEvents = [];
  tracking = true;
  lastPos = screen.getCursorScreenPoint();
  pollTimer = setInterval(() => {
    if (!tracking) return;
    const p = screen.getCursorScreenPoint();
    lastPos = p;
    events.push({ t: Date.now(), x: p.x, y: p.y, c: 0 });
  }, 16);

  if (process.platform === "darwin") {
    // sample the active window's bounds (for window-capture cursor mapping)
    winTimer = setInterval(async () => {
      if (!tracking) return;
      const w = await getFrontWindowBounds();
      if (w) {
        winSamples.push({
          t: Date.now(),
          title: w.title,
          owner: w.owner,
          x: w.x, y: w.y,
          width: w.width, height: w.height,
        });
      }
    }, 500);
  } else if (process.platform === "win32") {
    winSamplerProc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_STREAM_SAMPLER], { windowsHide: true });
    let buf = "";
    winSamplerProc.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop(); // keep a trailing partial line for the next chunk
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith("WINBOUNDS ")) {
          const w = parseWindowBoundsOutput(line.slice("WINBOUNDS ".length));
          if (w) {
            winSamples.push({
              t: Date.now(),
              title: w.title,
              owner: w.owner,
              x: w.x, y: w.y,
              width: w.width, height: w.height,
            });
          }
        } else if (line.startsWith("CURSORSHAPE ")) {
          shapeEvents.push({ t: Date.now(), shape: line.slice("CURSORSHAPE ".length).trim() });
        }
      }
    });
    winSamplerProc.on("error", (e) => console.log("[focal] windows sampler failed to start:", e.message));
  }

  let clicksAvailable = false;
  if (uIOhook) {
    try {
      if (!hookStarted) {
        uIOhook.on("mousedown", onMouseDown);
        uIOhook.start();
        hookStarted = true;
      }
      clicksAvailable = true;
    } catch (e) {
      console.log("[studio] global click hook failed:", e.message);
    }
  }
  return { clicksAvailable };
});

ipcMain.handle("track-stop", () => {
  tracking = false;
  clearInterval(pollTimer);
  clearInterval(winTimer);
  pollTimer = null;
  winTimer = null;
  if (winSamplerProc) {
    try { winSamplerProc.kill(); } catch {}
    winSamplerProc = null;
  }
  return { events, winSamples, shapeEvents };
});

/* ---------- Native capture (ScreenCaptureKit helper) ----------
 * Records screen/window/custom-area video via a small Swift helper instead of
 * Electron's desktopCapturer/getDisplayMedia — the helper sets showsCursor
 * to false on the actual capture stream, which genuinely excludes the cursor
 * from the recorded pixels (desktopCapturer doesn't reliably honor this,
 * especially for window sources — see renderer.html's old blur-erase
 * workaround). It also crops natively, so custom-area recording no longer
 * depends on a canvas being redrawn every frame while the window is minimized.
 */
// child_process.spawn can't exec a binary from inside the virtual asar
// archive (unlike fs.readFile, Electron doesn't auto-redirect spawn paths) —
// asarUnpack puts the real file at the mirrored .unpacked path instead.
const captureHelperPath = path.join(__dirname, "native", "focal_capture").replace("app.asar", "app.asar.unpacked");
let captureProc = null;
let captureOutPath = null;

function captureAvailable() {
  return process.platform === "darwin" && fs.existsSync(captureHelperPath);
}
ipcMain.handle("native-capture-available", () => captureAvailable());

ipcMain.handle("native-capture-start", (e, opts) => {
  return new Promise((resolve, reject) => {
    if (captureProc) { reject(new Error("a capture is already running")); return; }
    if (!captureAvailable()) { reject(new Error("native capture helper unavailable")); return; }

    const outPath = path.join(app.getPath("temp"), `focal-capture-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
    const args = ["record", "--out", outPath, "--fps", String(opts.fps || 60)];
    if (opts.kind === "window") {
      args.push("--window-title", opts.windowTitle || "");
      if (opts.windowOwner) args.push("--window-owner", opts.windowOwner);
    } else {
      const b = opts.displayBounds;
      args.push("--display-bounds", `${b.x},${b.y},${b.width},${b.height}`);
    }
    if (opts.crop) {
      const c = opts.crop;
      args.push("--crop", `${c.x},${c.y},${c.width},${c.height}`);
    }

    const proc = spawn(captureHelperPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let stderrBuf = "";
    let dims = null;
    let owner = null;
    let frame = null;
    proc.stderr.on("data", (d) => { stderrBuf += d.toString(); });
    proc.stdout.on("data", (d) => {
      const lines = d.toString().split("\n");
      for (const line of lines) {
        if (line.startsWith("DIMENSIONS")) {
          const parts = line.trim().split(/\s+/);
          const width = parseInt(parts[1], 10), height = parseInt(parts[2], 10);
          if (Number.isFinite(width) && Number.isFinite(height)) dims = { width, height };
        } else if (line.startsWith("OWNER ")) {
          owner = line.slice("OWNER ".length).trim();
        } else if (line.startsWith("WINDOWFRAME")) {
          const parts = line.trim().split(/\s+/);
          const [x, y, width, height] = parts.slice(1).map(Number);
          if ([x, y, width, height].every(Number.isFinite)) frame = { x, y, width, height };
        } else if (line.startsWith("CURSORSHAPE ")) {
          // Streamed for the whole recording, not just at start — collected
          // into the same shapeEvents buffer track-stop returns, alongside
          // the Windows sampler's CURSORSHAPE lines (see track-start above).
          shapeEvents.push({ t: Date.now(), shape: line.slice("CURSORSHAPE ".length).trim() });
        } else if (line.startsWith("RECORDING") && !settled) {
          settled = true;
          captureProc = proc;
          captureOutPath = outPath;
          resolve({ ok: true, dims, owner, frame });
        } else if (line.startsWith("ERROR") && !settled) {
          settled = true;
          try { proc.kill("SIGKILL"); } catch {}
          reject(new Error(line));
        }
      }
    });
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`capture helper exited early (code ${code}): ${stderrBuf.slice(0, 400)}`));
      }
      if (captureProc === proc) { captureProc = null; }
    });
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill("SIGKILL"); } catch {}
        reject(new Error("capture helper start timed out"));
      }
    }, 6000);
    proc.on("exit", () => clearTimeout(timeout));
  });
});

ipcMain.handle("native-capture-stop", () => {
  return new Promise((resolve) => {
    if (!captureProc) { resolve(null); return; }
    const proc = captureProc;
    const outPath = captureOutPath;
    let settled = false;
    proc.on("exit", (code) => {
      if (settled) return;
      settled = true;
      console.log(`[studio] capture helper exited (code ${code}) after stop request`);
      captureProc = null;
      captureOutPath = null;
      resolve({ path: outPath });
    });
    // Two independent ways to ask it to stop, in case one is ever missed —
    // SIGINT (the primary path) and a plain stdin write (the helper also
    // watches for a "stop" line on stdin as a fallback trigger).
    try { proc.kill("SIGINT"); } catch (e) { console.warn("[studio] SIGINT failed:", e.message); }
    try { proc.stdin.write("stop\n"); } catch (e) {}
    // If it's still not dead after a few seconds, nudge again before giving up.
    setTimeout(() => {
      if (settled) return;
      console.warn("[studio] capture helper hasn't exited 4s after stop — retrying SIGINT");
      try { proc.kill("SIGINT"); } catch (e) {}
    }, 4000);
    setTimeout(() => {
      if (!settled) {
        console.warn("[studio] capture helper still alive after 8s — sending SIGKILL");
        settled = true;
        try { proc.kill("SIGKILL"); } catch {}
        captureProc = null;
        captureOutPath = null;
        resolve({ path: outPath });
      }
    }, 8000);
  });
});

ipcMain.handle("native-capture-read", async (e, filePath) => {
  try {
    const buf = fs.readFileSync(filePath);
    try { fs.unlinkSync(filePath); } catch {}
    return buf;
  } catch (err) {
    console.error("[studio] native-capture-read failed:", err.message);
    throw new Error(`couldn't read recorded video (${err.message})`);
  }
});

/* ---------- Crash/reload recovery: persist the last recording ---------- */
const recoveryDir = () => path.join(app.getPath("userData"), "recovery");

ipcMain.handle("recovery-save", async (e, name, buf) => {
  fs.mkdirSync(recoveryDir(), { recursive: true });
  fs.writeFileSync(path.join(recoveryDir(), name), Buffer.from(buf));
  return true;
});

ipcMain.handle("recovery-check", () => {
  try { return fs.existsSync(path.join(recoveryDir(), "screen.webm")); }
  catch { return false; }
});

ipcMain.handle("recovery-load", async () => {
  try {
    const d = recoveryDir();
    if (!fs.existsSync(path.join(d, "screen.webm"))) return null;
    const out = { screen: fs.readFileSync(path.join(d, "screen.webm")) };
    if (fs.existsSync(path.join(d, "cam.webm"))) out.cam = fs.readFileSync(path.join(d, "cam.webm"));
    if (fs.existsSync(path.join(d, "mic.webm"))) out.mic = fs.readFileSync(path.join(d, "mic.webm"));
    if (fs.existsSync(path.join(d, "meta.json"))) out.meta = fs.readFileSync(path.join(d, "meta.json"), "utf8");
    return out;
  } catch { return null; }
});

/* ---------- Shareable link upload (0x0.st, anonymous, ~30-day retention) ---------- */
ipcMain.handle("share-upload", async (e, buf, name) => {
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from(buf)]), name);
  const res = await fetch("https://0x0.st", {
    method: "POST",
    body: fd,
    headers: { "User-Agent": "Focal/1.0" },
  });
  const text = (await res.text()).trim();
  if (!res.ok || !text.startsWith("http")) {
    throw new Error(text.slice(0, 120) || "Upload failed (HTTP " + res.status + ")");
  }
  return text;
});

/* ---------- Window helpers ---------- */
ipcMain.on("win-minimize", () => win && win.minimize());
ipcMain.on("win-restore", () => {
  if (!win) return;
  win.restore();
  win.show();
  win.focus();
});

/* ---------- Floating webcam self-view (while recording) ----------
 * A small always-on-top, click-through-free bubble so users can see
 * themselves while recording — the main window is minimized during
 * recording and the webcam otherwise stays invisible until editing.
 * Not part of the capture itself: the renderer relays JPEG frames from the
 * same MediaStream it's already recording, over IPC, at a modest interval —
 * simplest way to show a live feed in a second, separate renderer process
 * without opening a second concurrent handle on the camera device.
 */
ipcMain.handle("get-displays", () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    bounds: d.bounds,
    primary: d.id === primaryId,
    label: (d.label && d.label.trim()) || `Display ${i + 1}`,
  }));
});

let camPreviewWin = null;
let camPreviewFrameCount = 0;
const CAM_PREVIEW_SIZE = 220;

ipcMain.handle("cam-preview-open", (e, displayId) => {
  camPreviewFrameCount = 0;
  if (camPreviewWin && !camPreviewWin.isDestroyed()) return true;
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  const margin = 28;
  const x = Math.round(target.bounds.x + target.bounds.width - CAM_PREVIEW_SIZE - margin);
  const y = Math.round(target.bounds.y + target.bounds.height - CAM_PREVIEW_SIZE - margin);
  console.log(`[focal] cam preview opening at ${x},${y} on display ${target.id} (bounds ${JSON.stringify(target.bounds)})`);
  camPreviewWin = new BrowserWindow({
    x, y, width: CAM_PREVIEW_SIZE, height: CAM_PREVIEW_SIZE,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    movable: true, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    focusable: false, backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "cam-preview-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  camPreviewWin.setAlwaysOnTop(true, "screen-saver");
  try { camPreviewWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  camPreviewWin.loadFile("cam-preview.html");
  camPreviewWin.once("ready-to-show", () => camPreviewWin && camPreviewWin.show());
  camPreviewWin.webContents.on("did-fail-load", (ev, code, desc) => {
    console.log(`[focal] cam preview failed to load: ${code} ${desc}`);
  });
  camPreviewWin.on("closed", () => {
    console.log(`[focal] cam preview closed after ${camPreviewFrameCount} frames`);
    camPreviewWin = null;
  });
  return true;
});

ipcMain.on("cam-preview-close", () => {
  if (camPreviewWin && !camPreviewWin.isDestroyed()) camPreviewWin.close();
  camPreviewWin = null;
});

ipcMain.on("cam-preview-frame", (e, dataURL) => {
  camPreviewFrameCount++;
  if (camPreviewFrameCount === 1) console.log("[focal] cam preview: first frame relayed");
  if (camPreviewWin && !camPreviewWin.isDestroyed()) {
    camPreviewWin.webContents.send("cam-preview-frame", dataURL);
  }
});
