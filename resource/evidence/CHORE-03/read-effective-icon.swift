import AppKit
let app = CommandLine.arguments[1]
let output = CommandLine.arguments[2]
let icon = NSWorkspace.shared.icon(forFile: app)
guard let tiff = icon.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("No icon representation") }
try png.write(to: URL(fileURLWithPath: output))
print("effective-icon: \(bitmap.pixelsWide)x\(bitmap.pixelsHigh)")
