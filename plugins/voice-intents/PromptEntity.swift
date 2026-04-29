import AppIntents

// Wraps a free-text prompt string in an AppEntity so AskShortcuts phrases
// can substitute it with `\(\.$prompt)`. iOS 16's AppIntents metadata
// processor rejects String parameters as phrase slots — only AppEntity /
// AppEnum types are allowed. This entity satisfies that requirement
// without restricting the input to a known set.
//
// EntityStringQuery is the magic: Siri passes the user's dictated
// utterance to entities(matching:), and we wrap it back into a
// PromptEntity whose id IS the original text. Inside the AppIntent's
// perform(), read `prompt.id` to get the raw string the user spoke.

@available(iOS 16.0, *)
struct PromptEntity: AppEntity {
  let id: String

  static var typeDisplayRepresentation: TypeDisplayRepresentation {
    TypeDisplayRepresentation(name: "Prompt")
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: LocalizedStringResource(stringLiteral: id))
  }

  static var defaultQuery: PromptEntityQuery { PromptEntityQuery() }
}

@available(iOS 16.0, *)
struct PromptEntityQuery: EntityStringQuery {
  // Siri passes the user's spoken phrase here. We accept anything and
  // wrap it back as the entity's id — there is no curated list to filter
  // against.
  func entities(matching string: String) async throws -> [PromptEntity] {
    [PromptEntity(id: string)]
  }

  // Required by EntityQuery — used when re-resolving entities from
  // identifiers (e.g. across app launches). The id is the prompt text
  // itself, so this is a pass-through.
  func entities(for identifiers: [PromptEntity.ID]) async throws -> [PromptEntity] {
    identifiers.map { PromptEntity(id: $0) }
  }

  func suggestedEntities() async throws -> [PromptEntity] { [] }
}
