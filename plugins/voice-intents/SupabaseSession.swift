import Foundation
import Security

enum SupabaseSessionError: Error {
  case notLoggedIn
  case keychainError(OSStatus)
  case refreshFailed(reason: String)
}

@available(iOS 16.0, *)
struct SupabaseSession {
  static let accessGroup = "N6WPH3FPFA.io.zolva.shared"
  // expo-secure-store@15 internally appends ":no-auth" (or ":auth" with
  // requireAuthentication: true) to the keychainService value before passing
  // it to kSecAttrService. JS-side `keychainService: 'io.zolva.shared'`
  // thus stores items with kSecAttrService = "io.zolva.shared:no-auth", and
  // this reader must query with the same suffix. Verified empirically by
  // the SPIKE FIRST keychain probe (Task 0; see commit history on the
  // feat/widget-v2-siri branch + the project_widget_v2_keychain_findings
  // memory entry).
  static let service = "io.zolva.shared:no-auth"
  static let accessTokenAccount = "supabase.access_token"
  static let refreshTokenAccount = "supabase.refresh_token"

  static func readAccessToken() throws -> String { try readKey(accessTokenAccount) }
  static func readRefreshToken() throws -> String { try readKey(refreshTokenAccount) }
  static func writeAccessToken(_ token: String) throws { try writeKey(accessTokenAccount, value: token) }
  static func writeRefreshToken(_ token: String) throws { try writeKey(refreshTokenAccount, value: token) }

  private static func readKey(_ account: String) throws -> String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { throw SupabaseSessionError.notLoggedIn }
    guard status == errSecSuccess, let data = item as? Data,
          let token = String(data: data, encoding: .utf8) else {
      throw SupabaseSessionError.keychainError(status)
    }
    return token
  }

  private static func writeKey(_ account: String, value: String) throws {
    let baseQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: accessGroup,
    ]
    let data = Data(value.utf8)
    let updateAttrs: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
    ]
    let status = SecItemUpdate(baseQuery as CFDictionary, updateAttrs as CFDictionary)
    if status == errSecSuccess { return }
    if status != errSecItemNotFound { throw SupabaseSessionError.keychainError(status) }

    var addQuery = baseQuery
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw SupabaseSessionError.keychainError(addStatus)
    }
  }
}
