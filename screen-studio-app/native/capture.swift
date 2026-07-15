import ScreenCaptureKit
import AVFoundation
import CoreImage
import AppKit
import Foundation

func trace(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    fflush(stderr)
}

// ---------------- CLI args ----------------

struct Args {
    var mode = ""
    var windowID: CGWindowID?
    var displayID: CGDirectDisplayID?
    var outPath = ""
    var crop: CGRect?
    var fps = 30
    var duration: Double?
    var windowTitle: String?
    var windowOwner: String?
    var displayBounds: CGRect?
}

func parseArgs(_ argv: [String]) -> Args? {
    guard argv.count >= 2 else { return nil }
    var a = Args()
    a.mode = argv[1]
    var i = 2
    while i < argv.count {
        let key = argv[i]
        func next() -> String { i += 1; return i < argv.count ? argv[i] : "" }
        switch key {
        case "--window": a.windowID = CGWindowID(next())
        case "--display": a.displayID = CGDirectDisplayID(next())
        case "--out": a.outPath = next()
        case "--fps": a.fps = Int(next()) ?? 30
        case "--duration": a.duration = Double(next())
        case "--window-title": a.windowTitle = next()
        case "--window-owner": a.windowOwner = next()
        case "--display-bounds":
            let parts = next().split(separator: ",").compactMap { Double($0) }
            if parts.count == 4 { a.displayBounds = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3]) }
        case "--crop":
            let parts = next().split(separator: ",").compactMap { Double($0) }
            if parts.count == 4 { a.crop = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3]) }
        default: break
        }
        i += 1
    }
    return a
}

// ---------------- listing ----------------

func listTargets() async {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        for d in content.displays {
            print("display\t\(d.displayID)\t\(d.width)x\(d.height)")
        }
        for w in content.windows {
            let appName = w.owningApplication?.applicationName ?? "?"
            print("window\t\(w.windowID)\t\(appName)\t\(w.title ?? "")\t\(Int(w.frame.width))x\(Int(w.frame.height))\t\(Int(w.frame.origin.x)),\(Int(w.frame.origin.y))")
        }
    } catch {
        print("Failed to get shareable content: \(error)")
    }
}

// ---------------- pixel buffer cropping (plain top-left raster crop, no CoreImage Y-flip involved) ----------------

func cropPixelBuffer(_ src: CVPixelBuffer, toX x: Int, y: Int, w: Int, h: Int) -> CVPixelBuffer? {
    CVPixelBufferLockBaseAddress(src, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(src, .readOnly) }
    guard let srcBase = CVPixelBufferGetBaseAddress(src) else { return nil }
    let srcBytesPerRow = CVPixelBufferGetBytesPerRow(src)
    let srcW = CVPixelBufferGetWidth(src)
    let srcH = CVPixelBufferGetHeight(src)

    let cx = max(0, min(x, srcW - 1))
    let cy = max(0, min(y, srcH - 1))
    let cw = max(2, min(w, srcW - cx))
    let ch = max(2, min(h, srcH - cy))

    var maybeOut: CVPixelBuffer?
    let attrs: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
    CVPixelBufferCreate(kCFAllocatorDefault, cw, ch, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &maybeOut)
    guard let out = maybeOut else { return nil }
    CVPixelBufferLockBaseAddress(out, [])
    defer { CVPixelBufferUnlockBaseAddress(out, []) }
    guard let dstBase = CVPixelBufferGetBaseAddress(out) else { return nil }
    let dstBytesPerRow = CVPixelBufferGetBytesPerRow(out)

    let bpp = 4
    for row in 0..<ch {
        let srcRow = srcBase.advanced(by: (cy + row) * srcBytesPerRow + cx * bpp)
        let dstRow = dstBase.advanced(by: row * dstBytesPerRow)
        memcpy(dstRow, srcRow, cw * bpp)
    }
    return out
}

// ---------------- recording ----------------

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    let cropRect: CGRect? // in pixel coords, local to the captured buffer's own origin
    var firstPTS: CMTime?
    var started = false
    var frameCount = 0
    var stopping = false
    let onFatalError: (String) -> Void

    init(writer: AVAssetWriter, input: AVAssetWriterInput, adaptor: AVAssetWriterInputPixelBufferAdaptor, cropRect: CGRect?, onFatalError: @escaping (String) -> Void) {
        self.writer = writer
        self.input = input
        self.adaptor = adaptor
        self.cropRect = cropRect
        self.onFatalError = onFatalError
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopping, type == .screen, sampleBuffer.isValid,
              let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        var pixelBuffer = imageBuffer
        if let r = cropRect, let cropped = cropPixelBuffer(imageBuffer, toX: Int(r.minX), y: Int(r.minY), w: Int(r.width), h: Int(r.height)) {
            pixelBuffer = cropped
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if !started {
            started = true
            firstPTS = pts
            writer.startWriting()
            writer.startSession(atSourceTime: .zero)
        }
        guard let base = firstPTS else { return }
        let rel = CMTimeSubtract(pts, base)
        if input.isReadyForMoreMediaData {
            adaptor.append(pixelBuffer, withPresentationTime: rel)
            frameCount += 1
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        trace("stream stopped with error: \(error)")
        onFatalError("\(error)")
    }
}

func record(_ args: Args) async {
    _ = NSApplication.shared // required or SCContentFilter crashes (CGS_REQUIRE_INIT)

    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
        print("ERROR fetching shareable content: \(error)")
        return
    }

    let filter: SCContentFilter
    let originPoint: CGPoint
    var pointW: Double
    var pointH: Double

    func boundsClose(_ a: CGRect, _ b: CGRect, tol: Double = 3) -> Bool {
        abs(a.origin.x - b.origin.x) < tol && abs(a.origin.y - b.origin.y) < tol &&
        abs(a.width - b.width) < tol && abs(a.height - b.height) < tol
    }

    if let wid = args.windowID, let target = content.windows.first(where: { $0.windowID == wid }) {
        filter = SCContentFilter(desktopIndependentWindow: target)
        originPoint = target.frame.origin
        pointW = target.frame.width
        pointH = target.frame.height
    } else if let did = args.displayID, let target = content.displays.first(where: { $0.displayID == did }) {
        filter = SCContentFilter(display: target, excludingWindows: [])
        originPoint = target.frame.origin
        pointW = target.frame.width
        pointH = target.frame.height
    } else if let titleWanted = args.windowTitle {
        // Match by title (+ optional owning-app name), same fuzzy approach the
        // rest of Focal already uses for window identification — avoids
        // depending on Electron's opaque desktopCapturer source id format.
        let candidates = content.windows.filter { w in
            guard let t = w.title, !t.isEmpty else { return false }
            let titleMatches = t == titleWanted || t.contains(titleWanted) || titleWanted.contains(t)
            guard titleMatches else { return false }
            if let owner = args.windowOwner, !owner.isEmpty {
                return w.owningApplication?.applicationName == owner
            }
            return true
        }
        guard let target = candidates.first else {
            print("ERROR: no window matching title '\(titleWanted)' found")
            return
        }
        filter = SCContentFilter(desktopIndependentWindow: target)
        originPoint = target.frame.origin
        pointW = target.frame.width
        pointH = target.frame.height
    } else if let wantedBounds = args.displayBounds {
        guard let target = content.displays.first(where: { boundsClose($0.frame, wantedBounds) }) else {
            print("ERROR: no display matching bounds \(wantedBounds) found")
            return
        }
        filter = SCContentFilter(display: target, excludingWindows: [])
        originPoint = target.frame.origin
        pointW = target.frame.width
        pointH = target.frame.height
    } else {
        print("ERROR: no matching --window/--display/--window-title/--display-bounds target found")
        return
    }

    let config = SCStreamConfiguration()
    config.showsCursor = false // the whole point of this helper
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.queueDepth = 6
    config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(args.fps))
    // 1x point resolution for this proof of concept — simplifies crop math to a
    // direct 1:1 mapping; can be upsized to native/retina resolution later.
    config.width = max(2, Int(pointW))
    config.height = max(2, Int(pointH))

    var cropPixelRect: CGRect? = nil
    var outW = config.width
    var outH = config.height
    if let c = args.crop {
        let localX = c.minX - originPoint.x
        let localY = c.minY - originPoint.y
        cropPixelRect = CGRect(x: localX, y: localY, width: c.width, height: c.height)
        outW = Int(c.width) & ~1  // even dims for H.264
        outH = Int(c.height) & ~1
    } else {
        outW = outW & ~1
        outH = outH & ~1
    }

    try? FileManager.default.removeItem(atPath: args.outPath)
    guard let writer = try? AVAssetWriter(outputURL: URL(fileURLWithPath: args.outPath), fileType: .mp4) else {
        print("ERROR: could not create AVAssetWriter")
        return
    }
    let videoSettings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: outW,
        AVVideoHeightKey: outH,
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
    input.expectsMediaDataInRealTime = true
    let adaptorAttrs: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: outW,
        kCVPixelBufferHeightKey as String: outH,
    ]
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: adaptorAttrs)
    writer.add(input)

    // Dispatch sources are reference-counted objects — if nothing outside the
    // synchronous setup closure below retains them, ARC deallocates them the
    // instant that closure returns (which happens almost immediately, since
    // it just registers handlers and kicks off async work), silently
    // cancelling them before any real stop trigger can ever arrive. Retaining
    // them here, in record()'s own frame (alive for as long as the function
    // hasn't returned, i.e. the whole recording), keeps them live for real.
    var retainedSources: [DispatchSourceProtocol] = []

    trace("TRACE: entering continuation block")
    await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
        var resumed = false
        let resumeOnce = { (who: String) in
            trace("TRACE: resumeOnce called from \(who), already resumed=\(resumed)")
            if !resumed { resumed = true; cont.resume() }
        }

        // `onFatalError` needs to call `finish()`, but `finish` is defined
        // below (it needs `stream`, which needs `recorder` first) — this box
        // lets onFatalError call whatever `finish` ends up being once it's
        // assigned, instead of just abandoning the writer unfinalized (which
        // would leave no valid output file at all if the stream errors out
        // mid-recording, e.g. the window being recorded gets closed).
        var finishBox: () -> Void = {}
        let recorder = Recorder(writer: writer, input: input, adaptor: adaptor, cropRect: cropPixelRect) { errMsg in
            print("ERROR: stream failed: \(errMsg)")
            finishBox()
        }

        // Frame delivery AND the stop transition both go through this single
        // serial queue, so `recorder.stopping` can't be read by an in-flight
        // frame callback at the exact moment it flips true elsewhere — that
        // race let an adaptor.append() land after input.markAsFinished(),
        // which can silently wedge/abort the writer so finishWriting's
        // completion handler never fires (helper hangs until SIGKILL, and
        // since finishWriting never ran, no output file exists at all).
        let frameQueue = DispatchQueue(label: "focal.capture.frames")
        let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
        do {
            try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: frameQueue)
        } catch {
            print("ERROR: addStreamOutput failed: \(error)")
            resumeOnce("addStreamOutput catch")
            return
        }

        func finish() {
            frameQueue.async {
                trace("TRACE: finish() called, stopping=\(recorder.stopping)")
                guard !recorder.stopping else { return }
                recorder.stopping = true
                Task {
                    try? await stream.stopCapture()
                    guard recorder.started else {
                        // Never got a single frame (e.g. the stream errored out
                        // immediately) — there's nothing for finishWriting to
                        // finalize, and calling it anyway would hang forever.
                        trace("TRACE: finish() with no frames captured, skipping finishWriting")
                        resumeOnce("finish with no frames")
                        return
                    }
                    input.markAsFinished()
                    writer.finishWriting {
                        trace("wrote \(recorder.frameCount) frames -> \(args.outPath), status=\(writer.status.rawValue), error=\(String(describing: writer.error))")
                        print("DONE frames=\(recorder.frameCount) path=\(args.outPath)")
                        resumeOnce("finishWriting completion")
                    }
                }
            }
        }
        finishBox = finish

        // stop on "stop\n" from stdin
        let stdinSource = DispatchSource.makeReadSource(fileDescriptor: FileHandle.standardInput.fileDescriptor, queue: .global())
        stdinSource.setEventHandler {
            let data = FileHandle.standardInput.availableData
            trace("TRACE: stdin readable, \(data.count) bytes")
            if let s = String(data: data, encoding: .utf8), s.contains("stop") {
                finish()
            }
        }
        stdinSource.resume()
        retainedSources.append(stdinSource)

        // stop on SIGINT/SIGTERM too
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        sigSrc.setEventHandler { trace("TRACE: SIGINT"); finish() }
        sigSrc.resume()
        retainedSources.append(sigSrc)
        let sigSrc2 = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        sigSrc2.setEventHandler { trace("TRACE: SIGTERM"); finish() }
        sigSrc2.resume()
        retainedSources.append(sigSrc2)

        if let d = args.duration {
            DispatchQueue.global().asyncAfter(deadline: .now() + d) { trace("TRACE: duration elapsed"); finish() }
        }

        Task {
            do {
                trace("TRACE: calling startCapture")
                try await stream.startCapture()
                print("RECORDING \(args.outPath)")
                trace("TRACE: startCapture task block ending normally")
            } catch {
                print("ERROR: startCapture failed: \(error)")
                resumeOnce("startCapture catch")
            }
        }
    }
    trace("TRACE: continuation block returned, record() ending")
}

@main
struct FocalCapture {
    static func main() async {
        setbuf(stdout, nil) // unbuffered — otherwise prints sit in a buffer forever when stdout isn't a tty
        guard let args = parseArgs(CommandLine.arguments) else {
            print("usage:")
            print("  focal_capture list")
            print("  focal_capture record --window <id>|--display <id> --out <path.mp4> [--crop x,y,w,h] [--fps 30]")
            return
        }
        switch args.mode {
        case "list": await listTargets()
        case "record": await record(args)
        default: print("unknown mode \(args.mode)")
        }
    }
}
