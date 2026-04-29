import Foundation

struct WidgetActionResponse: Decodable {
  let dialog: String
  let snippet: Snippet
  struct Snippet: Decodable {
    let mood: String   // "happy" | "worried"
    let summary: String
    let deepLink: String
  }
}

enum IntentActionError: Error {
  case unauthorized
  case recoverable(reason: String)
}

@available(iOS 16.0, *)
enum IntentActionClient {
  static let projectRef = "sjkhfkatmeqtsrysixop"
  static let path = "/functions/v1/widget-action"

  // Test seam — XCTest assigns this before each case to bypass the network
  // path entirely. Production code never sets it.
  static var sendOverride: ((String, String) async throws -> WidgetActionResponse)?

  static func send(prompt: String, timezone: String) async throws -> WidgetActionResponse {
    if let override = sendOverride {
      return try await override(prompt, timezone)
    }
    let accessToken = try SupabaseSession.readAccessToken()
    do {
      return try await postOnce(prompt: prompt, timezone: timezone, jwt: accessToken)
    } catch IntentActionError.unauthorized {
      // Refresh re-reads the refresh token from keychain itself; we don't
      // cache it across the await. See SupabaseAuthClient.refresh() for
      // the concurrent-refresh race handling.
      let newAccessToken = try await SupabaseAuthClient.refresh()
      return try await postOnce(prompt: prompt, timezone: timezone, jwt: newAccessToken)
    }
  }

  private static func postOnce(prompt: String, timezone: String, jwt: String) async throws -> WidgetActionResponse {
    var req = URLRequest(url: URL(string: "https://\(projectRef).supabase.co\(path)")!)
    req.httpMethod = "POST"
    req.timeoutInterval = 6
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization")
    req.httpBody = try JSONEncoder().encode(SendRequest(prompt: prompt, timezone: timezone))

    let (data, response): (Data, URLResponse)
    do {
      (data, response) = try await URLSession.shared.data(for: req)
    } catch {
      throw IntentActionError.recoverable(reason: "network: \(error.localizedDescription)")
    }
    guard let http = response as? HTTPURLResponse else {
      throw IntentActionError.recoverable(reason: "no http response")
    }
    if http.statusCode == 401 { throw IntentActionError.unauthorized }
    guard http.statusCode == 200 else {
      throw IntentActionError.recoverable(reason: "HTTP \(http.statusCode)")
    }
    do {
      return try JSONDecoder().decode(WidgetActionResponse.self, from: data)
    } catch {
      throw IntentActionError.recoverable(reason: "decode: \(error.localizedDescription)")
    }
  }

  private struct SendRequest: Encodable {
    let prompt: String
    let timezone: String
  }
}
