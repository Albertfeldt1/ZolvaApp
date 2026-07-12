import React from 'react';
import { Alert, Linking, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';

// Minimal inline markdown: **bold** and *italic* spans plus tappable links —
// both [label](url) og bare https://…/www.… addresses. Tap opens the browser,
// long-press copies the address. Shared by the chat Bubble and the
// long-press action menu so the lifted copy of a message matches the
// original exactly.

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function openLink(url: string): void {
  Linking.openURL(normalizeUrl(url)).catch(() => Alert.alert('Link', 'Linket kunne ikke åbnes.'));
}

function copyLink(url: string): void {
  void Clipboard.setStringAsync(normalizeUrl(url));
  Haptics.selectionAsync().catch(() => {});
}

function LinkSpan({ url, label, color }: { url: string; label: string; color?: string }) {
  return (
    <Text
      accessibilityRole="link"
      accessibilityHint="Tryk for at åbne, hold nede for at kopiere"
      suppressHighlighting
      onPress={() => openLink(url)}
      onLongPress={() => copyLink(url)}
      style={{ color, textDecorationLine: 'underline' }}
    >
      {label}
    </Text>
  );
}

// Sentence punctuation glued to the end of a bare URL is not part of it —
// but keep a ')' that closes a '(' inside the URL (Wikipedia-style paths).
function trimTrailing(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = '';
  for (;;) {
    const ch = url[url.length - 1] ?? '';
    if (!')]},.!?;:\'"»›'.includes(ch)) break;
    if (ch === ')' && url.split('(').length - 1 >= url.split(')').length - 1) break;
    trailing = ch + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

function linkifyBare(text: string, color?: string): React.ReactNode[] {
  const parts = text.split(/((?:https?:\/\/|www\.)[^\s<>]+)/gi);
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const { url, trailing } = trimTrailing(part);
    return (
      <React.Fragment key={i}>
        <LinkSpan url={url} label={url} color={color} />
        {trailing}
      </React.Fragment>
    );
  });
}

/** Plain text → text with tappable links (no markdown handling). For user
 * bubbles, noterede fakta and note bodies. */
export function renderLinks(text: string, color?: string): React.ReactNode[] {
  // Split into [plain, label, url, plain, label, url, …, plain].
  const parts = text.split(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const plain = parts[i];
    if (plain) out.push(<React.Fragment key={`p${i}`}>{linkifyBare(plain, color)}</React.Fragment>);
    const label = parts[i + 1];
    const url = parts[i + 2];
    if (label != null && url != null) out.push(<LinkSpan key={`l${i}`} url={url} label={label} color={color} />);
  }
  return out;
}

// Single-asterisk *kursiv* spans. The content must not touch whitespace on
// the inside, so list bullets ("* punkt") and arithmetic ("2 * 3") stay
// literal. Runs AFTER the **bold** split, so the leftover segments can never
// contain a double asterisk pair. An unmatched lone '*' stays as-is.
const ITALIC_RE = /\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*/g;

function renderItalicSegments(text: string, linkColor?: string): React.ReactNode[] {
  const parts = text.split(ITALIC_RE);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <Text key={`i${i}`} style={{ fontStyle: 'italic' }}>
        {renderLinks(part, linkColor)}
      </Text>
    ) : (
      <React.Fragment key={`i${i}`}>{renderLinks(part, linkColor)}</React.Fragment>
    ),
  );
}

export function renderInlineMd(text: string, boldFamily: string, linkColor?: string): React.ReactNode[] {
  const parts = text.split(/\*\*([\s\S]+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <Text key={i} style={{ fontFamily: boldFamily }}>
        {renderItalicSegments(part, linkColor)}
      </Text>
    ) : (
      <React.Fragment key={i}>{renderItalicSegments(part, linkColor)}</React.Fragment>
    ),
  );
}
