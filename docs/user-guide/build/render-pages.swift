// Renders every page of a PDF to PNG with PDFKit (macOS), for looking at the guide.
//
//   swift build/render-pages.swift <file.pdf> <outdir> [dpi]      # default 110 dpi
//   swift build/render-pages.swift <file.pdf> --outline            # print the bookmarks as JSON
//
// Writes <outdir>/page-01.png, page-02.png, ... on a white ground.
import AppKit
import Foundation
import PDFKit

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("usage: swift render-pages.swift <file.pdf> <outdir> [dpi]\n       swift render-pages.swift <file.pdf> --outline\n".data(using: .utf8)!)
  exit(2)
}
let pdfURL = URL(fileURLWithPath: args[1])
guard let doc = PDFDocument(url: pdfURL) else {
  FileHandle.standardError.write("cannot open \(args[1])\n".data(using: .utf8)!)
  exit(1)
}

if args[2] == "--outline" {
  var rows: [[String: Any]] = []
  func walk(_ node: PDFOutline, _ depth: Int) {
    for i in 0..<node.numberOfChildren {
      guard let c = node.child(at: i) else { continue }
      var page = -1
      if let p = c.destination?.page { page = doc.index(for: p) + 1 }
      rows.append(["title": c.label ?? "", "depth": depth, "page": page])
      walk(c, depth + 1)
    }
  }
  if let root = doc.outlineRoot { walk(root, 0) }
  let data = try! JSONSerialization.data(withJSONObject: ["pages": doc.pageCount, "outline": rows], options: [.prettyPrinted])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}

let outDir = URL(fileURLWithPath: args[2])
let dpi = args.count > 3 ? (Double(args[3]) ?? 110) : 110
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let scale = CGFloat(dpi / 72.0)

for i in 0..<doc.pageCount {
  guard let page = doc.page(at: i) else { continue }
  let box = page.bounds(for: .mediaBox)
  let w = Int((box.width * scale).rounded()), h = Int((box.height * scale).rounded())
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let ctx = NSGraphicsContext(bitmapImageRep: rep) else { continue }
  let cg = ctx.cgContext
  cg.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  cg.fill(CGRect(x: 0, y: 0, width: w, height: h))
  cg.scaleBy(x: scale, y: scale)
  cg.translateBy(x: -box.origin.x, y: -box.origin.y)
  page.draw(with: .mediaBox, to: cg)
  let name = String(format: "page-%02d.png", i + 1)
  if let png = rep.representation(using: .png, properties: [:]) {
    try png.write(to: outDir.appendingPathComponent(name))
  }
}
print("\(doc.pageCount) pages -> \(outDir.path)")
