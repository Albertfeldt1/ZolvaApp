import React, { useEffect, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { ArrowRight } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirSpace } from '../../design/papir';
import { useTodayBrief } from '../../lib/briefs';
import { useWorkPreferences } from '../../lib/hooks';
import { formatToday } from '../../lib/date';
import { usePapirNav } from './nav';
import { BRIEF_TONE } from './PapirHome';
import { PapirLoader } from './PapirLoader';
import { PushHeader } from './PushHeader';
import { useNow } from './useNow';

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen, marginTop: 24 }} />
      <View style={{ paddingHorizontal: papirSpace.screen, paddingTop: 22 }}>
        {/* ink3 like every other section eyebrow (Home, Historik) — red is
            reserved for active/urgent/CTA per the token semantics, and a red
            "VEJRET" label inflates the accent into meaninglessness. */}
        <PaperText role="eyebrow" color={papirColor.ink3}>
          {label}
        </PaperText>
        <View style={{ marginTop: 10 }}>{children}</View>
      </View>
    </>
  );
}

// Editorial principle: the whole briefing is Zolva's SPOKEN morning-paper
// voice, so section content is serif throughout (eyebrows/meta stay sans).
// Before this, VEJRET/INDBAKKE were sans while AT HUSKE was serif — two
// typographic voices on one page.
function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <PaperText key={`${i}-${line.slice(0, 24)}`} role="bodySerif" color={papirColor.ink2} style={{ paddingVertical: 4 }}>
          {line}
        </PaperText>
      ))}
    </>
  );
}

// Greeting follows the CLOCK, subtitle follows the brief's kind — an evening
// brief left open past midnight must not say "Godaften" at 06:00 (QA L15).
function greetingFor(now: Date, kind: 'morning' | 'midday' | 'evening'): string {
  const h = now.getHours();
  const hello = h < 10 ? 'Godmorgen' : h < 17 ? 'Goddag' : 'Godaften';
  const line = kind === 'morning' ? 'her er din dag.' : kind === 'midday' ? 'her er status.' : 'her er din dag i morgen.';
  return `${hello},\n${line}`;
}

/** "Næste briefing om 2 t 14 min" — countdown to the next scheduled brief.
 * `value` is the work-pref time ("08.00"; same format isMorningBriefReady
 * accepts). Already-passed times roll to tomorrow; unparsable → null so the
 * empty state keeps today's copy. */
function nextBriefCountdown(value: string, now: Date): string | null {
  const m = value.match(/^(\d{1,2})\.(\d{2})$/);
  if (!m) return null;
  const next = new Date(now);
  next.setHours(parseInt(m[1], 10), parseInt(m[2], 10), 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  const mins = Math.ceil((next.getTime() - now.getTime()) / 60_000);
  const h = Math.floor(mins / 60);
  const min = mins % 60;
  if (h === 0) return `Næste briefing om ${min} min`;
  if (min === 0) return `Næste briefing om ${h} t`;
  return `Næste briefing om ${h} t ${min} min`;
}

export function PapirBriefing() {
  const nav = usePapirNav();
  const { brief, loading, markRead, refresh } = useTodayBrief();
  const { data: workPrefs } = useWorkPreferences();
  // "Opdatér" only re-FETCHES — it can't generate a brief (H12). Tell the
  // user when the next one actually lands instead of a dead-feeling button.
  const morningTime = workPrefs.find((p) => p.id === 'morning-brief')?.value ?? '';
  const scheduleLine =
    morningTime && morningTime !== 'Fra'
      ? `Din morgenbriefing lander her hver dag kl. ${morningTime}.`
      : 'Din briefing lander her, når den er genereret.';

  // Opening the briefing = reading it (same semantics as the classic modal).
  useEffect(() => {
    if (brief && !brief.readAt) void markRead();
  }, [brief, markRead]);

  // Ticks per minute: keeps the empty-state countdown live and the greeting
  // honest if the screen is left open across a threshold.
  const now = useNow();
  const countdown = morningTime && morningTime !== 'Fra' ? nextBriefCountdown(morningTime, now) : null;
  const d = formatToday(now);
  const genTime = brief
    ? `${String(brief.generatedAt.getHours()).padStart(2, '0')}.${String(brief.generatedAt.getMinutes()).padStart(2, '0')}`
    : '';
  const eyebrow = brief
    ? `${d.weekdayFull} · ${d.day}. ${d.monthFull} · ${genTime}`
    : `${d.weekdayFull} · ${d.day}. ${d.monthFull}`;

  // Tone tag in the eyebrow — additive and restrained: calm IS the default
  // look (no tag), busy gets rust, only heads-up may borrow the red accent.
  const toneMeta = brief?.tone && brief.tone !== 'calm' ? BRIEF_TONE[brief.tone] : null;

  const s = brief?.sections ?? null;
  const weatherLines = s?.weather?.length
    ? s.weather
    : brief?.weather
      ? [`${Math.round(brief.weather.tempC)}° og ${brief.weather.conditionLabel.toLowerCase()}.`]
      : [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
    >
      <PushHeader title="Briefing" />

      {loading && !brief ? (
        <View style={{ alignItems: 'center', paddingTop: 80 }}>
          <PapirLoader />
        </View>
      ) : !brief ? (
        <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 12 }}>
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Ingen briefing endnu
          </PaperText>
          {/* Live countdown (per-minute via useNow); the schedule sentence
              drops to secondary. No parseable time → today's copy as-is. */}
          {countdown ? (
            <PaperText role="body" color={papirColor.ink2} style={{ textAlign: 'center' }}>
              {countdown}
            </PaperText>
          ) : null}
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>
            {scheduleLine}
          </PaperText>
          <Button label="Tjek igen" variant="ghost" style={{ paddingHorizontal: 24 }} onPress={() => void refresh()} />
        </View>
      ) : (
        <>
          <View style={{ paddingHorizontal: papirSpace.screen }}>
            <PaperText role="eyebrow" color={papirColor.ink3}>
              {eyebrow}
              {toneMeta ? (
                <PaperText role="eyebrow" color={toneMeta.color}>{` · ${toneMeta.label}`}</PaperText>
              ) : null}
            </PaperText>
            <PaperText role="displayM" style={{ marginTop: 12 }}>
              {greetingFor(now, brief.kind)}
            </PaperText>
            <PaperText role="bodySerif" color={papirColor.ink2} style={{ marginTop: 20 }}>
              {brief.headline}
            </PaperText>
          </View>

          {s ? (
            <>
              {weatherLines.length > 0 ? (
                <Section label="Vejret">
                  <Lines lines={weatherLines} />
                </Section>
              ) : null}

              {s.calendar.length > 0 ? (
                <Section label="Dagens plan">
                  <Lines lines={s.calendar} />
                </Section>
              ) : null}

              {s.mails.length > 0 ? (
                <Section label="Indbakke">
                  <ScaleButton scaleTo={0.99} haptic="light" onPress={() => nav.push('inbox')}>
                    <Lines lines={s.mails} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
                      <PaperText role="small" color={papirColor.red}>
                        Åbn indbakke
                      </PaperText>
                      <ArrowRight size={14} color={papirColor.red} strokeWidth={2} />
                    </View>
                  </ScaleButton>
                </Section>
              ) : null}

              {s.followups.length > 0 || s.focus.length > 0 ? (
                <Section label="At huske">
                  {/* Full-ink serif (no size override): same voice as the other
                      sections, weight carried by color alone. */}
                  {[...s.followups, ...s.focus].map((line, i) => (
                    <PaperText key={`${i}-${line.slice(0, 24)}`} role="bodySerif" style={{ paddingVertical: 4 }}>
                      {line}
                    </PaperText>
                  ))}
                </Section>
              ) : null}
            </>
          ) : (
            // Legacy briefs (pre-structured rebuild): prose paragraphs.
            <Section label="Din dag">
              {brief.body.map((p, i) => (
                <PaperText key={`${i}-${p.slice(0, 24)}`} role="bodySerif" color={papirColor.ink2} style={{ paddingVertical: 6 }}>
                  {p}
                </PaperText>
              ))}
            </Section>
          )}
        </>
      )}
    </ScrollView>
  );
}
