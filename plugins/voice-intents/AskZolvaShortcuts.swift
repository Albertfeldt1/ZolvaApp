import AppIntents

@available(iOS 16.0, *)
struct AskZolvaShortcuts: AppShortcutsProvider {
  // Single-shot phrases substitute the dictated text directly into
  // \(\.$prompt). The metadata processor allows the slot because prompt
  // is now a PromptEntity (AppEntity-conforming) rather than a String —
  // see PromptEntity.swift for the EntityStringQuery shim.
  // Bare phrases (no slot) fall back to requestValueDialog, which still
  // works as the two-turn fallback if Siri's NL parser doesn't capture
  // the trailing utterance for a slot phrase.
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskZolvaIntent(),
      phrases: [
        "Bed \(.applicationName) om at \(\.$prompt)",
        "Sig til \(.applicationName) at \(\.$prompt)",
        "Spørg \(.applicationName) om \(\.$prompt)",
        "Ask \(.applicationName) to \(\.$prompt)",
        "Tell \(.applicationName) to \(\.$prompt)",
        "Spørg \(.applicationName)",
        "Bed \(.applicationName)",
        "Ask \(.applicationName)",
      ],
      shortTitle: "Spørg Zolva",
      systemImageName: "bubble.left.fill"
    )
  }
}
