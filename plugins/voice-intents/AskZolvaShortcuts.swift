import AppIntents

@available(iOS 16.0, *)
struct AskZolvaShortcuts: AppShortcutsProvider {
  // Phrase order matters for Siri's intent routing. App-name-FIRST phrases
  // win over Apple's first-party Calendar / Reminders intents because the
  // trigger word "Zolva" disambiguates immediately — without it, "sæt et
  // møde i morgen" gets matched by Apple Calendar's create-event intent
  // before reaching us. Apple's AppShortcut HIG explicitly recommends
  // app-name-first phrases for this reason.
  //
  // Verb-first phrases (Bed / Sig til / Ask / Tell) stay as fallbacks for
  // users who don't think to lead with the app name. They'll occasionally
  // lose to Apple's Calendar intent — known limitation.
  //
  // Bare phrases (no slot) trigger requestValueDialog as a two-turn
  // fallback for users who say "Spørg Zolva" without follow-up.
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskZolvaIntent(),
      phrases: [
        // App-name-first single-shot — primary path, beats Apple's Calendar.
        "\(.applicationName), \(\.$prompt)",
        "\(.applicationName) \(\.$prompt)",
        // Verb-first single-shot — may lose to first-party intents.
        "Bed \(.applicationName) om at \(\.$prompt)",
        "Sig til \(.applicationName) at \(\.$prompt)",
        "Spørg \(.applicationName) om \(\.$prompt)",
        "Ask \(.applicationName) to \(\.$prompt)",
        "Tell \(.applicationName) to \(\.$prompt)",
        // Bare-trigger fallbacks — two-turn via requestValueDialog.
        "Spørg \(.applicationName)",
        "Bed \(.applicationName)",
        "Ask \(.applicationName)",
      ],
      shortTitle: "Spørg Zolva",
      systemImageName: "bubble.left.fill"
    )
  }
}
