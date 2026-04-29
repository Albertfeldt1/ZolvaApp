import SwiftUI
import UIKit

enum AskZolvaSnippetState {
  case success(summary: String, deepLink: URL)
  case error(message: String, deepLink: URL)
}

@available(iOS 16.0, *)
struct AskZolvaSnippetView: View {
  let state: AskZolvaSnippetState

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Stone(mood: stoneMood)
        .frame(width: 56, height: 56)
      VStack(alignment: .leading, spacing: 4) {
        Text(text)
          .font(.body)
          .foregroundColor(.primary)
          .lineLimit(3)
        Text(subtitle)
          .font(.caption)
          .foregroundColor(.secondary)
      }
      Spacer()
    }
    .padding(.vertical, 8)
    .contentShape(Rectangle())
    .onTapGesture { open(url) }
  }

  private var stoneMood: StoneMood {
    switch state {
    case .success: return .happy
    case .error: return .worried
    }
  }

  private var text: String {
    switch state {
    case .success(let summary, _): return summary
    case .error(let message, _): return message
    }
  }

  private var subtitle: String {
    switch state {
    case .success: return "Tryk for at åbne"
    case .error: return "Tryk for at rette"
    }
  }

  private var url: URL {
    switch state {
    case .success(_, let u), .error(_, let u): return u
    }
  }

  private func open(_ url: URL) {
    // AppIntents snippets cannot directly call openURL; the wrapper Siri
    // overlay forwards the tap to the host app via the system URL handler.
    // The deep-link is the snippet's "primary action" via .onTapGesture.
    UIApplication.shared.open(url)
  }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Snippet success") {
  AskZolvaSnippetView(state: .success(
    summary: "Møde med Sophie · i morgen kl. sytten",
    deepLink: URL(string: "zolva://calendar/event/abc123")!
  ))
}
@available(iOS 17.0, *)
#Preview("Snippet error — recoverable") {
  AskZolvaSnippetView(state: .error(
    message: "Forstod ikke. Prøv igen i appen.",
    deepLink: URL(string: "zolva://chat")!
  ))
}
@available(iOS 17.0, *)
#Preview("Snippet error — auth (logged out)") {
  AskZolvaSnippetView(state: .error(
    message: "Logget ud — åbn Zolva for at logge ind igen.",
    deepLink: URL(string: "zolva://settings")!
  ))
}
@available(iOS 17.0, *)
#Preview("Snippet error — permission") {
  AskZolvaSnippetView(state: .error(
    message: "Du har ikke skriverettigheder til Acme Work Cal.",
    deepLink: URL(string: "zolva://settings")!
  ))
}
#endif
