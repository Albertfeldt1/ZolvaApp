import SwiftUI

enum StoneMood {
  case happy
  case worried
}

// SwiftUI port of src/components/Stone.tsx, rendered statically for the
// AppIntent snippet view. The RN version animates (blinks, gaze tracking,
// hop on tap); this version drops the animation since snippets are
// short-lived and Apple's snippet container doesn't support arbitrary
// gestures. Preserves the visual identity: asymmetric pebble path,
// radial gradient, top-left highlight, layered eyes with paper highlight,
// quadratic-curve mouth.
//
// All coords/scales reference the source SVG's viewBox of 54×48.
struct Stone: View {
  let mood: StoneMood

  // Source-of-truth viewBox from Stone.tsx (line 118). Preserving the
  // exact ratio means future tweaks to the RN version's path data can be
  // ported by 1:1 coordinate copy without re-deriving offsets.
  private let viewBoxW: CGFloat = 54
  private let viewBoxH: CGFloat = 48

  var body: some View {
    GeometryReader { geo in
      let scale = min(geo.size.width / viewBoxW, geo.size.height / viewBoxH)
      let w = viewBoxW * scale
      let h = viewBoxH * scale

      ZStack(alignment: .topLeading) {
        // Body — the asymmetric pebble silhouette.
        PebbleShape()
          .fill(
            RadialGradient(
              gradient: Gradient(stops: [
                .init(color: Color(red: 0.545, green: 0.608, blue: 0.498), location: 0.00),  // #8B9B7F
                .init(color: Color(red: 0.361, green: 0.451, blue: 0.333), location: 0.55),  // #5C7355
                .init(color: Color(red: 0.239, green: 0.306, blue: 0.220), location: 1.00),  // #3D4E38
              ]),
              center: UnitPoint(x: 0.35, y: 0.30),
              startRadius: 0,
              endRadius: max(w, h) * 0.75
            )
          )
          .frame(width: w, height: h)

        // Top-left highlight ellipse — mirrors the SVG's <Ellipse cx=20 cy=14 rx=6 ry=3 />.
        Ellipse()
          .fill(Color.white.opacity(0.25))
          .frame(width: 12 * scale, height: 6 * scale)
          .offset(x: (20 - 6) * scale, y: (14 - 3) * scale)

        // Eyes — the SVG groups are at translate(19, 22) and translate(33, 22),
        // each containing a 3.2-radius black pupil and a 1.1-radius paper
        // highlight at offset (-0.9, -1) from the pupil center.
        eye(centerX: 19, centerY: 22, scale: scale)
        eye(centerX: 33, centerY: 22, scale: scale)

        // Mouth — quadratic curve. Coords match the SVG d-attribute paths.
        MouthShape(mood: mood)
          .stroke(Color.black.opacity(0.5), style: StrokeStyle(lineWidth: 1.4 * scale, lineCap: .round))
          .frame(width: w, height: h)
      }
      .frame(width: w, height: h, alignment: .topLeading)
      .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
    }
    .aspectRatio(viewBoxW / viewBoxH, contentMode: .fit)
  }

  private func eye(centerX: CGFloat, centerY: CGFloat, scale: CGFloat) -> some View {
    ZStack {
      Circle()
        .fill(Color.black)
        .frame(width: 6.4 * scale, height: 6.4 * scale)  // r = 3.2 → d = 6.4
      Circle()
        .fill(Color.white)
        .frame(width: 2.2 * scale, height: 2.2 * scale)  // r = 1.1 → d = 2.2
        .offset(x: -0.9 * scale, y: -1 * scale)
    }
    .offset(x: (centerX - 3.2) * scale, y: (centerY - 3.2) * scale)
  }
}

// Asymmetric pebble path — direct port of the SVG <Path d="..."/> from
// Stone.tsx line 127. Coordinates are unchanged; the Shape's `path(in:)`
// scales the unit data to whatever rect SwiftUI gives it.
private struct PebbleShape: Shape {
  func path(in rect: CGRect) -> Path {
    let sx = rect.width / 54
    let sy = rect.height / 48
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
    }
    var path = Path()
    path.move(to: p(4, 28))
    // C 2 14 14 2 28 3
    path.addCurve(to: p(28, 3), control1: p(2, 14), control2: p(14, 2))
    // C 44 4 54 18 50 32
    path.addCurve(to: p(50, 32), control1: p(44, 4), control2: p(54, 18))
    // C 47 43 34 48 22 46
    path.addCurve(to: p(22, 46), control1: p(47, 43), control2: p(34, 48))
    // C 10 44 6 38 4 28
    path.addCurve(to: p(4, 28), control1: p(10, 44), control2: p(6, 38))
    path.closeSubpath()
    return path
  }
}

// Mouth path — quadratic curves from the MOUTH constants in Stone.tsx.
// Happy uses the larger smile (M 20 33 q 7 6 14 0); worried inverts the
// control point so the curve frowns. The 'calm' / 'thinking' moods exist
// in the RN version but the snippet view only uses success vs error.
private struct MouthShape: Shape {
  let mood: StoneMood

  func path(in rect: CGRect) -> Path {
    let sx = rect.width / 54
    let sy = rect.height / 48
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
    }
    var path = Path()
    switch mood {
    case .happy:
      // M 20 33 q 7 6 14 0  — relative quadratic. Endpoint is (20+14, 33+0) = (34, 33),
      // control point is (20+7, 33+6) = (27, 39).
      path.move(to: p(20, 33))
      path.addQuadCurve(to: p(34, 33), control: p(27, 39))
    case .worried:
      // Invert control y to flip the curve: smile-down arc.
      path.move(to: p(20, 35))
      path.addQuadCurve(to: p(34, 35), control: p(27, 30))
    }
    return path
  }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Stone happy") { Stone(mood: .happy).frame(width: 56, height: 56) }
@available(iOS 17.0, *)
#Preview("Stone worried") { Stone(mood: .worried).frame(width: 56, height: 56) }
#endif
