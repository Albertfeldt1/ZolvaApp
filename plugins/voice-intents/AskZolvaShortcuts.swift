import AppIntents

@available(iOS 16.0, *)
struct AskZolvaShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskZolvaIntent(),
      phrases: [
        "Bed \(.applicationName) om at \(\.$prompt)",
        "Sig til \(.applicationName) at \(\.$prompt)",
        "Spørg \(.applicationName)",
        "Ask \(.applicationName)",
        "Ask \(.applicationName) to \(\.$prompt)",
      ],
      shortTitle: "Spørg Zolva",
      systemImageName: "bubble.left.fill"
    )
  }
}
