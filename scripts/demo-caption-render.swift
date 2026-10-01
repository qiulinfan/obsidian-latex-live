#!/usr/bin/env swift
import AppKit
import Foundation

// Text graphics only. This program never captures a display or reads a user's UI.
let help = """
Usage: demo-caption-render --width PIXELS --height PIXELS --title TEXT --text TEXT --out FILE.png
Renders a black caption rail with one title line and at most two caption lines.
System fonts handle Chinese and English; PNG dimensions exactly match the arguments.
"""
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
var values: [String: String] = [:]
var index = 1
let args = CommandLine.arguments
while index < args.count {
    if args[index] == "--help" || args[index] == "-h" { print(help); exit(0) }
    guard args[index].hasPrefix("--"), index + 1 < args.count else { fail(help) }
    values[args[index]] = args[index + 1]; index += 2
}
guard let width = Int(values["--width"] ?? ""), width >= 240,
      let height = Int(values["--height"] ?? ""), height >= 96,
      let output = values["--out"], !output.isEmpty else { fail(help) }
let title = values["--title"] ?? ""
let text = (values["--text"] ?? "").replacingOccurrences(of: "\r", with: "")
let lines = text.isEmpty ? [] : text.components(separatedBy: "\n")
guard lines.count <= 2 else { fail("Caption text must have at most two lines.") }
guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fail("Cannot create the caption bitmap.") }
bitmap.size = NSSize(width: width, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.shouldAntialias = true
NSColor.black.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()
let margin: CGFloat = 20
let available = CGFloat(width) - margin * 2
func fontFitting(_ strings: [String], maximum: CGFloat, minimum: CGFloat, weight: NSFont.Weight) -> NSFont {
    var size = maximum
    while size > minimum {
        let font = NSFont.systemFont(ofSize: size, weight: weight)
        if strings.allSatisfy({ ($0 as NSString).size(withAttributes: [.font: font]).width <= available }) { return font }
        size -= 1
    }
    return NSFont.systemFont(ofSize: minimum, weight: weight)
}
let titleFont = fontFitting([title], maximum: 17, minimum: 11, weight: .semibold)
let captionFont = fontFitting(lines, maximum: min(26, CGFloat(height) * 0.205), minimum: 12, weight: .regular)
for line in lines {
    guard (line as NSString).size(withAttributes: [.font: captionFont]).width <= available + 1 else {
        fail("Caption line does not fit this video width. Use shorter text or a wider source recording.")
    }
}
let titleParagraph = NSMutableParagraphStyle()
titleParagraph.lineBreakMode = .byTruncatingTail
(title as NSString).draw(in: NSRect(x: margin, y: CGFloat(height) - 35, width: available, height: 25),
    withAttributes: [.font: titleFont, .foregroundColor: NSColor(white: 0.78, alpha: 1), .paragraphStyle: titleParagraph])
let lineHeight = max(29, captionFont.pointSize + 7)
let firstY = CGFloat(height) - 36 - lineHeight
for (number, line) in lines.enumerated() {
    (line as NSString).draw(in: NSRect(x: margin, y: firstY - CGFloat(number) * lineHeight, width: available, height: lineHeight),
        withAttributes: [.font: captionFont, .foregroundColor: NSColor.white])
}
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else { fail("Cannot encode PNG.") }
let url = URL(fileURLWithPath: output)
do {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try png.write(to: url, options: .atomic)
    print("caption PNG: \(width)x\(height)")
} catch { fail("Caption PNG could not be written: \(error.localizedDescription)") }
