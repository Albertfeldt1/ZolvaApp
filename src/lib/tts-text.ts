// Pure text prep for text-to-speech — kept dependency-free so it can be unit
// tested without mocking expo-audio/supabase (which tts.ts pulls in).

/** Model replies are markdown-ish and can contain URLs — both read terribly
 * aloud. Strip formatting and read link labels instead of addresses. */
export function stripForSpeech(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) → label
    .replace(/https?:\/\/\S+/g, 'link') // raw URLs → "link"
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
    .replace(/\*([^*]+)\*/g, '$1') // *italic*
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/^\s*[-–•]\s+/gm, '') // bullet markers
    .replace(/`{1,3}/g, '') // code ticks
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
