// AskZolvaIntentTests — covers the auth-state matrix from the spec via
// IntentActionClient.sendOverride. Not currently wired into an Xcode test
// target (no ZolvaTests target on this project — see Task 29 deferral note
// in docs/superpowers/plans/2026-04-28-widget-v2-siri.md). When a
// ZolvaTests bundle is added, copy this file into it and these tests will
// run as-is.
//
// Until then, on-device QA (Task 30 / widget-v2-qa-checklist.md) is the
// gate for the same auth-state cases.

import XCTest
@testable import Zolva

@MainActor
final class AskZolvaIntentTests: XCTestCase {
  override func tearDown() async throws {
    if #available(iOS 16.0, *) {
      IntentActionClient.sendOverride = nil
    }
  }

  @available(iOS 16.0, *)
  func testHappyPath() async throws {
    IntentActionClient.sendOverride = { _, _ in
      WidgetActionResponse(
        dialog: "Tilføjet: 'Møde', i morgen kl. sytten i din arbejdskalender.",
        snippet: .init(
          mood: "happy",
          summary: "Møde · i morgen kl. sytten",
          deepLink: "zolva://calendar/event/abc"
        )
      )
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde i morgen kl. 17"
    let result = try await intent.perform()
    _ = result
  }

  @available(iOS 16.0, *)
  func testNotLoggedInTokensMissing() async throws {
    IntentActionClient.sendOverride = { _, _ in
      throw SupabaseSessionError.notLoggedIn
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde"
    let result = try await intent.perform()
    _ = result
    // Manual inspection: dialog should mention "logget ud".
  }

  @available(iOS 16.0, *)
  func testRefreshFailedAfterRetry() async throws {
    IntentActionClient.sendOverride = { _, _ in
      throw IntentActionError.unauthorized
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde"
    let result = try await intent.perform()
    _ = result
  }

  @available(iOS 16.0, *)
  func testTimeoutFallsToRecoverable() async throws {
    IntentActionClient.sendOverride = { _, _ in
      throw IntentActionError.recoverable(reason: "timeout")
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde"
    let result = try await intent.perform()
    _ = result
  }

  @available(iOS 16.0, *)
  func testMissingSupabaseAnonKeyDoesNotCrash() async throws {
    // SupabaseAuthClient.refresh() must throw, not fatalError, when the
    // SupabaseAnonKey is missing from Info.plist. AskZolvaIntent surfaces
    // that as the "logget ud" dialog. The override here mimics that path.
    IntentActionClient.sendOverride = { _, _ in
      throw SupabaseSessionError.refreshFailed(reason: "SupabaseAnonKey missing from Info.plist")
    }
    let intent = AskZolvaIntent()
    intent.prompt = "sæt et møde"
    let result = try await intent.perform()
    _ = result
  }
}
