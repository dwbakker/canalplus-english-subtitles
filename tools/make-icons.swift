// Draws the extension and app icons (gradient glass tile with "EN").
// Run from the repo root: swift tools/make-icons.swift
import AppKit

func icon(_ px: Int, inset: CGFloat) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    let rect = NSRect(x: s * inset, y: s * inset, width: s * (1 - 2 * inset), height: s * (1 - 2 * inset))
    let radius = rect.width * 0.235
    let tile = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

    // Soft drop shadow (app icon only; tiny sizes stay crisp).
    if inset > 0 {
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
        shadow.shadowBlurRadius = s * 0.025
        shadow.shadowOffset = NSSize(width: 0, height: -s * 0.012)
        shadow.set()
        NSColor.black.setFill(); tile.fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    NSGraphicsContext.saveGraphicsState()
    tile.addClip()
    NSGradient(colors: [NSColor(srgbRed: 0.24, green: 0.55, blue: 1, alpha: 1),
                        NSColor(srgbRed: 0.48, green: 0.36, blue: 1, alpha: 1),
                        NSColor(srgbRed: 1, green: 0.37, blue: 0.64, alpha: 1)])!
        .draw(in: rect, angle: -45)
    // Glass sheen: a bright wash over the top half.
    NSGradient(colors: [NSColor.white.withAlphaComponent(0.38), NSColor.white.withAlphaComponent(0)])!
        .draw(in: NSRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2), angle: -90)
    NSGraphicsContext.restoreGraphicsState()

    // Bright rim along the edge.
    NSColor.white.withAlphaComponent(0.55).setStroke()
    let rim = NSBezierPath(roundedRect: rect.insetBy(dx: s * 0.006, dy: s * 0.006), xRadius: radius, yRadius: radius)
    rim.lineWidth = max(1, s * 0.012)
    rim.stroke()

    let font = NSFont.systemFont(ofSize: rect.width * 0.42, weight: .heavy)
    let text = NSAttributedString(string: "EN", attributes: [.font: font, .foregroundColor: NSColor.white, .kern: rect.width * 0.01])
    let size = text.size()
    text.draw(at: NSPoint(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2 + rect.width * 0.01))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let fm = FileManager.default
try fm.createDirectory(atPath: "src/icons", withIntermediateDirectories: true)
for px in [16, 32, 48, 64, 96, 128, 256, 512] {
    try icon(px, inset: 0).write(to: URL(fileURLWithPath: "src/icons/icon-\(px).png"))
}
// macOS app icon: Apple's grid leaves ~10% margin around the tile.
let set = "apple/English Subtitles for CANAL+/English Subtitles for CANAL+/Assets.xcassets/AppIcon.appiconset"
var images: [[String: String]] = []
for (pt, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let name = "icon_\(pt)x\(pt)@\(scale)x.png"
    try icon(pt * scale, inset: 0.1).write(to: URL(fileURLWithPath: "\(set)/\(name)"))
    images.append(["idiom": "mac", "size": "\(pt)x\(pt)", "scale": "\(scale)x", "filename": name])
}
let json = try JSONSerialization.data(withJSONObject: ["images": images, "info": ["author": "xcode", "version": 1]], options: [.prettyPrinted, .sortedKeys])
try json.write(to: URL(fileURLWithPath: "\(set)/Contents.json"))
print("icons written")
