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
  let payload: SnapshotPayload?
  let isStale: Bool
}

struct SnapshotProvider: TimelineProvider {
  func placeholder(in context: Context) -> SnapshotEntry {
    SnapshotEntry(date: Date(), payload: nil, isStale: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
    completion(currentEntry(at: Date()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
    let now = Date()
    let payload = loadSnapshotFromAppGroup()
    let stale = isStale(payload, at: now)
    let dates = buildEntryDates(payload: payload, now: now)
    let entries = dates.map { d in
      SnapshotEntry(date: d, payload: stale ? payload : payload, isStale: stale)
    }
    completion(Timeline(entries: entries, policy: .atEnd))
  }

  private func currentEntry(at now: Date) -> SnapshotEntry {
    let payload = loadSnapshotFromAppGroup()
    return SnapshotEntry(date: now, payload: payload, isStale: isStale(payload, at: now))
  }

  private func isStale(_ payload: SnapshotPayload?, at now: Date) -> Bool {
    guard let p = payload else { return true }
    return now.timeIntervalSince(p.generatedAt) > SnapshotConst.staleThreshold
  }

  private func buildEntryDates(payload: SnapshotPayload?, now: Date) -> [Date] {
    var dates: [Date] = [now]
    let cal = Calendar.current
    if let p = payload {
      for event in p.todayEvents {
        let nudgeStart = event.start.addingTimeInterval(-30 * 60)
        if nudgeStart > now { dates.append(nudgeStart) }
        if event.start > now { dates.append(event.start) }
        let endPlus = event.end.addingTimeInterval(60)
        if endPlus > now { dates.append(endPlus) }
      }
    }
    if let evening = cal.date(bySettingHour: 17, minute: 0, second: 0, of: now), evening > now {
      dates.append(evening)
    }
    if let tomorrow = cal.date(byAdding: .day, value: 1, to: now),
       let tomorrow6am = cal.date(bySettingHour: 6, minute: 0, second: 0, of: tomorrow) {
      dates.append(tomorrow6am)
    }
    // Dedup + sort, cap at 16 to stay well under iOS 40-entry limit.
    let uniqueSorted = Array(Set(dates)).sorted()
    return Array(uniqueSorted.prefix(16))
  }
}

struct MediumWidgetView: View {
  let entry: SnapshotEntry
  var body: some View {
    Text("Zolva")
  }
}
