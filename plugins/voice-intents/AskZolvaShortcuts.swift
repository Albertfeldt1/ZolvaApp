import AppIntents

@available(iOS 16.0, *)
struct AskZolvaShortcuts: AppShortcutsProvider {
  // Phrases must be free of parameter substitution: AppIntent's metadata
  // processor only allows AppEntity / AppEnum slots in AppShortcut phrases,
  // not String. The transcript is captured via requestValueDialog on the
  // `prompt` parameter (two-turn flow: trigger phrase → Siri prompts → user
  // dictates). Single-shot phrasing would require a custom AppEntity, which
  // is out of scope for v2.
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskZolvaIntent(),
      phrases: [
        "Spørg \(.applicationName)",
        "Bed \(.applicationName)",
        "Sig til \(.applicationName)",
        "Ask \(.applicationName)",
      ],
      shortTitle: "Spørg Zolva",
      systemImageName: "bubble.left.fill"
    )
  }
}
