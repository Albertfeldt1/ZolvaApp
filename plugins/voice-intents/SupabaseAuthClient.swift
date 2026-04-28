import Foundation

@available(iOS 16.0, *)
struct SupabaseAuthClient {
  static let projectRef = "sjkhfkatmeqtsrysixop"

  private static func anonKey() throws -> String {
    guard let key = Bundle.main.object(forInfoDictionaryKey: "SupabaseAnonKey") as? String,
          !key.isEmpty else {
      throw SupabaseSessionError.refreshFailed(reason: "SupabaseAnonKey missing from Info.plist")
    }
    return key
  }

  /// Refresh the access token. Always re-reads the refresh token from
  /// keychain immediately before the POST — never caches across awaits.
  /// This narrows (but does not eliminate) the window where the main app
  /// and the AppIntent both try to refresh concurrently with the same
  /// rotated-out refresh token.
  static func refresh() async throws -> String {
    let key = try anonKey()
    let refreshToken = try SupabaseSession.readRefreshToken()

    var req = URLRequest(url: URL(string:
      "https://\(projectRef).supabase.co/auth/v1/token?grant_type=refresh_token")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(key, forHTTPHeaderField: "apikey")
    req.httpBody = try JSONEncoder().encode(RefreshRequest(refresh_token: refreshToken))

    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse else {
      throw SupabaseSessionError.refreshFailed(reason: "no response")
    }
    if http.statusCode == 400 || http.statusCode == 401 {
      // Race-loss case: the main app refreshed first and rotated the token
      // we just used. Re-read the keychain — if the access token there is
      // newer than what we originally tried with, return it directly.
      // Otherwise this really is a "logged out" state.
      if let nowAccessToken = try? SupabaseSession.readAccessToken(),
         (try? SupabaseSession.readRefreshToken()) != refreshToken {
        // Refresh token in keychain has rotated since we read it → main app refreshed.
        return nowAccessToken
      }
      throw SupabaseSessionError.refreshFailed(reason: "HTTP \(http.statusCode) — refresh token rejected")
    }
    guard http.statusCode == 200 else {
      throw SupabaseSessionError.refreshFailed(reason: "HTTP \(http.statusCode)")
    }
    let body = try JSONDecoder().decode(RefreshResponse.self, from: data)
    try SupabaseSession.writeAccessToken(body.access_token)
    if let newRefresh = body.refresh_token {
      try SupabaseSession.writeRefreshToken(newRefresh)
    }
    return body.access_token
  }

  private struct RefreshRequest: Encodable {
    let refresh_token: String
  }

  private struct RefreshResponse: Decodable {
    let access_token: String
    let refresh_token: String?
  }
}
