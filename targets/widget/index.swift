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
    VStack(alignment: .leading, spacing: 0) {
      contextRow
        .frame(maxWidth: .infinity, alignment: .leading)
      Spacer(minLength: 0)
      chatRow
    }
    .padding(14)
    .containerBackground(for: .widget) {
      Color(red: 0.93, green: 0.89, blue: 0.84) // paper-ish, matches app background
    }
  }

  // MARK: - Context block (top)

  @ViewBuilder
  private var contextRow: some View {
    if entry.isStale || entry.payload == nil {
      staleState
    } else if let brief = morningBriefHeadline {
      briefState(headline: brief)
    } else if let nudge = currentMeetingNudge {
      meetingState(nudge)
    } else if let evening = eveningBriefHeadline {
      eveningState(headline: evening)
    } else if let next = nextEvent {
      nextEventState(next)
    } else {
      chatOnlyContext
    }
  }

  private var staleState: some View {
    Link(destination: URL(string: "zolva://today")!) {
      Text("Åbn Zolva for at opdatere").font(.callout).foregroundStyle(.secondary)
    }
  }

  private func briefState(headline: String) -> some View {
    Link(destination: URL(string: "zolva://today")!) {
      Text(headline).font(.headline).lineLimit(3).multilineTextAlignment(.leading)
    }
  }

  private func meetingState(_ nudge: MeetingNudge) -> some View {
    Link(destination: URL(string: "zolva://calendar/event/\(nudge.event.id)")!) {
      VStack(alignment: .leading, spacing: 4) {
        if nudge.during {
          Text("Du er i et møde:").font(.caption).foregroundStyle(.secondary)
          Text(nudge.event.title).font(.headline).lineLimit(2)
        } else {
          Text("Du har et møde om \(nudge.event.title)").font(.headline).lineLimit(2)
          Text("om ").font(.caption) +
            Text(nudge.event.start, style: .relative).font(.caption)
        }
      }
    }
  }

  private func eveningState(headline: String) -> some View {
    Link(destination: URL(string: "zolva://today")!) {
      Text(headline).font(.headline).lineLimit(3).multilineTextAlignment(.leading)
    }
  }

  private func nextEventState(_ event: SnapshotEvent) -> some View {
    Link(destination: URL(string: "zolva://calendar/event/\(event.id)")!) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Næste:").font(.caption).foregroundStyle(.secondary)
        (Text(event.title) + Text(" · ") + Text(event.start, style: .relative))
          .font(.callout).lineLimit(2)
      }
    }
  }

  private var chatOnlyContext: some View {
    Text("Spørg Zolva...")
      .font(.title3)
      .foregroundStyle(.primary)
  }

  // MARK: - Chat row (bottom)

  private var chatRow: some View {
    Link(destination: URL(string: "zolva://chat?focus=1")!) {
      HStack(spacing: 8) {
        Circle().fill(Color(red: 0.42, green: 0.55, blue: 0.45)).frame(width: 14, height: 14)
        Text(chatPromptText)
          .font(.subheadline).foregroundStyle(.secondary)
        Spacer()
      }
      .padding(.top, 8)
    }
  }

  // MARK: - Derived state

  private var morningBriefHeadline: String? {
    guard
      let brief = entry.payload?.morningBrief,
      let hour = Calendar.current.dateComponents([.hour], from: entry.date).hour,
      (6..<10).contains(hour)
    else { return nil }
    return brief.headline
  }

  private var eveningBriefHeadline: String? {
    guard
      let brief = entry.payload?.eveningBrief,
      let hour = Calendar.current.dateComponents([.hour], from: entry.date).hour,
      hour >= 17
    else { return nil }
    return brief.headline
  }

  private var currentMeetingNudge: MeetingNudge? {
    guard let events = entry.payload?.todayEvents else { return nil }
    let now = entry.date
    for event in events {
      let nudgeStart = event.start.addingTimeInterval(-30 * 60)
      if now >= event.start && now <= event.end {
        return MeetingNudge(event: event, during: true)
      }
      if now >= nudgeStart && now < event.start {
        return MeetingNudge(event: event, during: false)
      }
    }
    return nil
  }

  private var nextEvent: SnapshotEvent? {
    entry.payload?.todayEvents.first(where: { $0.start > entry.date })
  }

  private var chatPromptText: String {
    if let prompt = entry.payload?.chatPrompt, !prompt.isEmpty { return prompt }
    return "Spørg Zolva..."
  }
}

private struct MeetingNudge {
  let event: SnapshotEvent
  let during: Bool
}

#if DEBUG
import SwiftUI

#Preview("Placeholder", as: .systemMedium) {
  ZolvaMediumWidget()
} timeline: {
  SnapshotEntry(date: Date(), payload: nil, isStale: false)
}

#Preview("Stale", as: .systemMedium) {
  ZolvaMediumWidget()
} timeline: {
  SnapshotEntry(
    date: Date(),
    payload: SnapshotPayload(
      schema: 1,
      generatedAt: Date().addingTimeInterval(-25 * 60 * 60),
      morningBrief: BriefHeadline(headline: "Old"),
      eveningBrief: nil,
      todayEvents: [],
      chatPrompt: ""
    ),
    isStale: true
  )
}

#Preview("Morning Brief", as: .systemMedium) {
  ZolvaMediumWidget()
} timeline: {
  SnapshotEntry(
    date: Calendar.current.date(bySettingHour: 8, minute: 0, second: 0, of: Date())!,
    payload: SnapshotPayload(
      schema: 1,
      generatedAt: Date(),
      morningBrief: BriefHeadline(headline: "Tre møder, ét fokuspunkt: Q2-budget."),
      eveningBrief: nil,
      todayEvents: [],
      chatPrompt: ""
    ),
    isStale: false
  )
}

#Preview("Meeting Nudge", as: .systemMedium) {
  ZolvaMediumWidget()
} timeline: {
  let now = Date()
  let event = SnapshotEvent(
    id: "evt1",
    start: now.addingTimeInterval(20 * 60),
    end: now.addingTimeInterval(80 * 60),
    title: "Q2-budget review"
  )
  SnapshotEntry(
    date: now,
    payload: SnapshotPayload(
      schema: 1,
      generatedAt: now,
      morningBrief: nil,
      eveningBrief: nil,
      todayEvents: [event],
      chatPrompt: ""
    ),
    isStale: false
  )
}

#Preview("Evening Recap", as: .systemMedium) {
  ZolvaMediumWidget()
} timeline: {
  SnapshotEntry(
    date: Calendar.current.date(bySettingHour: 19, minute: 0, second: 0, of: Date())!,
    payload: SnapshotPayload(
      schema: 1,
      generatedAt: Date(),
      morningBrief: nil,
      eveningBrief: BriefHeadline(headline: "Du klarede tre møder. Resten kan vente."),
      todayEvents: [],
      chatPrompt: ""
    ),
    isStale: false
  )
}

#Preview("Next Event", as: .systemMedium) {
  ZolvaMediumWidget()
} timeline: {
  let now = Date()
  let event = SnapshotEvent(
    id: "evt2",
    start: now.addingTimeInterval(2 * 60 * 60),
    end: now.addingTimeInterval(3 * 60 * 60),
    title: "Lunch med Maria"
  )
  SnapshotEntry(
    date: now,
    payload: SnapshotPayload(
      schema: 1,
      generatedAt: now,
      morningBrief: nil,
      eveningBrief: nil,
      todayEvents: [event],
      chatPrompt: ""
    ),
    isStale: false
  )
}

#Preview("Chat Only", as: .systemMedium) {
  ZolvaMediumWidget()
} timeline: {
  SnapshotEntry(
    date: Date(),
    payload: SnapshotPayload(
      schema: 1,
      generatedAt: Date(),
      morningBrief: nil,
      eveningBrief: nil,
      todayEvents: [],
      chatPrompt: ""
    ),
    isStale: false
  )
}
#endif
