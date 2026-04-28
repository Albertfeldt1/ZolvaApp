// targets/widget/SnapshotPayload.swift
//
// JSON contract — must stay in sync with src/lib/widget-snapshot.ts.
// Schema is checked on decode; mismatches fall through to placeholder.

import Foundation

enum SnapshotConst {
  static let expectedSchema = 1
  static let appGroupId = "group.io.zolva.app"
  static let snapshotFilename = "widget-snapshot.json"
  static let staleThreshold: TimeInterval = 24 * 60 * 60
}

struct SnapshotEvent: Codable {
  let id: String
  let start: Date
  let end: Date
  let title: String
}

struct BriefHeadline: Codable {
  let headline: String
}

struct SnapshotPayload: Codable {
  let schema: Int
  let generatedAt: Date
  let morningBrief: BriefHeadline?
  let eveningBrief: BriefHeadline?
  let todayEvents: [SnapshotEvent]
  let chatPrompt: String
}

func decodeSnapshot(_ data: Data) -> SnapshotPayload? {
  let decoder = JSONDecoder()
  decoder.dateDecodingStrategy = .iso8601
  guard let payload = try? decoder.decode(SnapshotPayload.self, from: data) else { return nil }
  guard payload.schema == SnapshotConst.expectedSchema else { return nil }
  return payload
}

func loadSnapshotFromAppGroup() -> SnapshotPayload? {
  guard
    let dir = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: SnapshotConst.appGroupId
    )
  else { return nil }
  let url = dir.appendingPathComponent(SnapshotConst.snapshotFilename)
  guard let data = try? Data(contentsOf: url) else { return nil }
  return decodeSnapshot(data)
}
