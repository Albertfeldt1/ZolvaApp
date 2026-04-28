import SwiftUI

enum StoneMood {
  case happy
  case worried
}

struct Stone: View {
  let mood: StoneMood

  var body: some View {
    GeometryReader { geo in
      let s = min(geo.size.width, geo.size.height)
      ZStack {
        // Body — soft green pebble.
        Ellipse()
          .fill(LinearGradient(
            colors: [Color(red: 0.42, green: 0.55, blue: 0.42), Color(red: 0.32, green: 0.44, blue: 0.32)],
            startPoint: .top, endPoint: .bottom
          ))
          .frame(width: s * 0.92, height: s * 0.78)
          .offset(y: s * 0.04)

        // Eyes.
        HStack(spacing: s * 0.18) {
          Circle().fill(Color.white).frame(width: s * 0.10, height: s * 0.10)
            .overlay(Circle().fill(Color.black).frame(width: s * 0.05, height: s * 0.05))
          Circle().fill(Color.white).frame(width: s * 0.10, height: s * 0.10)
            .overlay(Circle().fill(Color.black).frame(width: s * 0.05, height: s * 0.05))
        }
        .offset(y: -s * 0.06)

        // Mouth.
        mouthShape
          .stroke(Color.black, style: StrokeStyle(lineWidth: s * 0.035, lineCap: .round))
          .frame(width: s * 0.32, height: s * 0.18)
          .offset(y: s * 0.18)
      }
    }
    .aspectRatio(1, contentMode: .fit)
  }

  // Mouth path is parametric on a unit square; the parent .frame and .stroke
  // scale it. `.happy` curves up at the corners; `.worried` curves down.
  private var mouthShape: Path {
    Path { p in
      switch mood {
      case .happy:
        p.move(to: CGPoint(x: 0, y: 0))
        p.addQuadCurve(to: CGPoint(x: 1, y: 0), control: CGPoint(x: 0.5, y: 1))
      case .worried:
        p.move(to: CGPoint(x: 0, y: 1))
        p.addQuadCurve(to: CGPoint(x: 1, y: 1), control: CGPoint(x: 0.5, y: 0))
      }
    }
  }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Stone happy") { Stone(mood: .happy).frame(width: 56, height: 56) }
@available(iOS 17.0, *)
#Preview("Stone worried") { Stone(mood: .worried).frame(width: 56, height: 56) }
#endif
