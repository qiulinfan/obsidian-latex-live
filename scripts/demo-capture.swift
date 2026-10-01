// macOS ScreenCaptureKit: record one selected application window, never the desktop or audio.
// Build: swiftc -parse-as-library scripts/demo-capture.swift -o <ignored-cache>/demo-capture
// Inventory: demo-capture list [bundle-id]
// Record: demo-capture record <window-id> <output.mp4> <stop-file> [bundle-id] [width]
// Creating stop-file finishes the MP4. SIGINT/SIGTERM also finish it; hard cap is 30 minutes.
import Foundation
import AppKit
import ScreenCaptureKit
import CoreGraphics
import CoreMedia
import CoreVideo
import AVFoundation

final class Completion {
    private let lock = NSLock()
    private var value: Result<Void, Error>?
    private var waiter: CheckedContinuation<Void, Error>?
    func finish(_ result: Result<Void, Error>) {
        lock.lock()
        if value != nil { lock.unlock(); return }
        value = result
        let current = waiter
        waiter = nil
        lock.unlock()
        current?.resume(with: result)
    }
    func wait() async throws {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let current = value { lock.unlock(); continuation.resume(with: current) }
            else { waiter = continuation; lock.unlock() }
        }
    }
}

final class RecorderDelegate: NSObject, SCRecordingOutputDelegate, SCStreamDelegate {
    let began = Completion()
    let ended = Completion()
    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) { began.finish(.success(())) }
    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) { ended.finish(.success(())) }
    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        began.finish(.failure(error)); ended.finish(.failure(error))
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        began.finish(.failure(error)); ended.finish(.failure(error))
    }
}

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) {
        print(text); fflush(stdout)
    }
}

@main struct Capture {
    static func main() async {
        do { try await run() }
        catch { emit(["event": "error", "message": error.localizedDescription]); exit(1) }
    }
    @MainActor static func run() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let args = Array(CommandLine.arguments.dropFirst())
        guard let mode = args.first, mode == "list" || mode == "record" else {
            emit(["error": "Usage: list [bundle-id] | record window-id output.mp4 stop-file [bundle-id] [width]"])
            exit(2)
        }
        // Inventory never prompts or records. A caller can complete the OS permission step
        // separately when the user is ready to record.
        guard CGPreflightScreenCaptureAccess() else {
            emit(["event": "permission-required", "screenCapture": false]); exit(3)
        }
        let app = mode == "list" ? (args.count > 1 ? args[1] : "md.obsidian") : (args.count > 4 ? args[4] : "md.obsidian")
        let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let windows = shareable.windows.filter { $0.owningApplication?.bundleIdentifier == app && $0.frame.width >= 200 && $0.frame.height >= 150 }
        if mode == "list" {
            emit(["event": "windows", "bundleID": app, "windows": windows.map { window in
                ["id": window.windowID, "title": window.title ?? "", "onScreen": window.isOnScreen,
                 "width": window.frame.width, "height": window.frame.height] as [String: Any]
            }]); return
        }
        guard args.count >= 4, let id = UInt32(args[1]), let window = windows.first(where: { $0.windowID == id }) else {
            emit(["error": "Selected window was not found in the requested application."]); exit(2)
        }
        let output = URL(fileURLWithPath: args[2])
        let stop = args[3]
        guard !FileManager.default.fileExists(atPath: output.path), !FileManager.default.fileExists(atPath: stop) else {
            emit(["error": "Output or stop-file already exists; choose fresh paths."]); exit(2)
        }
        let width = args.count > 5 ? (Int(args[5]) ?? 1920) : 1920
        let height = max(2, Int(Double(width) * window.frame.height / window.frame.width) / 2 * 2)
        let configuration = SCStreamConfiguration()
        configuration.width = width / 2 * 2
        configuration.height = height
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = true
        configuration.showMouseClicks = true
        configuration.capturesAudio = false
        configuration.captureMicrophone = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.queueDepth = 5
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let delegate = RecorderDelegate()
        let stream = SCStream(filter: filter, configuration: configuration, delegate: delegate)
        let file = SCRecordingOutputConfiguration()
        file.outputURL = output
        file.videoCodecType = .h264
        file.outputFileType = .mp4
        let recording = SCRecordingOutput(configuration: file, delegate: delegate)
        try stream.addRecordingOutput(recording)
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        let stopSignal: () -> Void = { _ = try? Data().write(to: URL(fileURLWithPath: stop)) }
        interrupt.setEventHandler(handler: stopSignal)
        terminate.setEventHandler(handler: stopSignal)
        interrupt.resume(); terminate.resume()
        try await stream.startCapture()
        try await delegate.began.wait()
        let start = Date()
        emit(["event": "started", "windowID": id, "bundleID": app, "output": output.path,
              "width": configuration.width, "height": configuration.height, "fps": 30, "audio": false,
              "startedAtUnixMs": start.timeIntervalSince1970 * 1000,
              "startedAt": ISO8601DateFormatter().string(from: start)])
        while !FileManager.default.fileExists(atPath: stop) && Date().timeIntervalSince(start) < 1800 {
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        try await stream.stopCapture()
        try await delegate.ended.wait()
        interrupt.cancel(); terminate.cancel()
        emit(["event": "finished", "elapsedSeconds": Date().timeIntervalSince(start), "output": output.path])
    }
}
