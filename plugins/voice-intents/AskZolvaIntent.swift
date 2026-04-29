import AppIntents
import Foundation

@available(iOS 16.0, *)
struct AskZolvaIntent: AppIntent {
  static var title: LocalizedStringResource = "Ask Zolva"
  static var description = IntentDescription("Bed Zolva om at sætte et møde i din kalender via stemmen.")

  @Parameter(
    title: "What do you want to ask Zolva?",
    requestValueDialog: IntentDialog("Hvad vil du bede Zolva om?")
  )
  var prompt: PromptEntity

  func perform() async throws -> some IntentResult & ProvidesDialog & ShowsSnippetView {
    let promptText = prompt.id
    do {
      let response = try await IntentActionClient.send(
        prompt: promptText,
        timezone: TimeZone.current.identifier
      )
      let snippetState: AskZolvaSnippetState
      let url = URL(string: response.snippet.deepLink) ?? URL(string: "zolva://chat")!
      switch response.snippet.mood {
      case "happy":
        snippetState = .success(summary: response.snippet.summary, deepLink: url)
      default:
        snippetState = .error(message: response.snippet.summary, deepLink: url)
      }
      return .result(
        dialog: IntentDialog(stringLiteral: response.dialog),
        view: AskZolvaSnippetView(state: snippetState)
      )
    } catch SupabaseSessionError.notLoggedIn {
      return .result(
        dialog: "Logget ud — åbn Zolva for at logge ind igen.",
        view: AskZolvaSnippetView(state: .error(
          message: "Logget ud — åbn Zolva for at logge ind igen.",
          deepLink: URL(string: "zolva://settings")!
        ))
      )
    } catch SupabaseSessionError.refreshFailed {
      return .result(
        dialog: "Du er logget ud — åbn Zolva for at logge ind igen.",
        view: AskZolvaSnippetView(state: .error(
          message: "Du er logget ud.",
          deepLink: URL(string: "zolva://settings")!
        ))
      )
    } catch IntentActionError.unauthorized {
      // Already retried inside IntentActionClient; bubbling out means the
      // refresh path also threw .unauthorized — treat as logged out.
      return .result(
        dialog: "Du er logget ud — åbn Zolva for at logge ind igen.",
        view: AskZolvaSnippetView(state: .error(
          message: "Du er logget ud.",
          deepLink: URL(string: "zolva://settings")!
        ))
      )
    } catch {
      return .result(
        dialog: "Forbindelse fejlede. Prøv igen.",
        view: AskZolvaSnippetView(state: .error(
          message: "Forbindelse fejlede. Prøv igen.",
          deepLink: URL(string: "zolva://chat")!
        ))
      )
    }
  }
}
