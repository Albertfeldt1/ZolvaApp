import WidgetKit
import SwiftUI

@main
struct ZolvaWidgetBundle: WidgetBundle {
  var body: some Widget {
    ZolvaMediumWidget()
  }
}

struct ZolvaMediumWidget: Widget {
  let kind: String = "io.zolva.app.medium"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
      MediumWidgetView(entry: entry)
    }
    .configurationDisplayName("Zolva")
    .description("Dagens overblik og hurtig adgang til chat.")
    .supportedFamilies([.systemMedium])
  }
}

// Stubs land in Tasks 7-9. Compile-only for now.
struct SnapshotEntry: TimelineEntry {
  let date: Date
}

struct SnapshotProvider: TimelineProvider {
  func placeholder(in context: Context) -> SnapshotEntry {
    SnapshotEntry(date: Date())
  }
  func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
    completion(SnapshotEntry(date: Date()))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
    completion(Timeline(entries: [SnapshotEntry(date: Date())], policy: .atEnd))
  }
}

struct MediumWidgetView: View {
  let entry: SnapshotEntry
  var body: some View {
    Text("Zolva")
  }
}
