import React, { useEffect, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { ArrowRight } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirSpace } from '../../design/papir';
import { useTodayBrief } from '../../lib/briefs';
import { formatToday } from '../../lib/date';
import { usePapirNav } from './nav';
import { PushHeader } from './PushHeader';

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <View style={{ height: 1, backgroundColor: papirColor.line, marginHorizontal: papirSpace.screen, marginTop: 24 }} />
      <View style={{ paddingHorizontal: papirSpace.screen, paddingTop: 22 }}>
        <PaperText role="eyebrow" color={papirColor.red}>
          {label}
        </PaperText>
        <View style={{ marginTop: 10 }}>{children}</View>
      </View>
    </>
  );
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) => (
        <PaperText key={`${i}-${line.slice(0, 24)}`} role="body" color={papirColor.ink2} style={{ paddingVertical: 4 }}>
          {line}
        </PaperText>
      ))}
    </>
  );
}

const KIND_GREETING: Record<'morning' | 'midday' | 'evening', string> = {
  morning: 'Godmorgen,\nher er din dag.',
  midday: 'Goddag,\nher er status.',
  evening: 'Godaften,\nher er din dag i morgen.',
};

export function PapirBriefing() {
  const nav = usePapirNav();
  const { brief, loading, markRead, refresh } = useTodayBrief();

  // Opening the briefing = reading it (same semantics as the classic modal).
  useEffect(() => {
    if (brief && !brief.readAt) void markRead();
  }, [brief, markRead]);

  const now = new Date();
  const d = formatToday(now);
  const genTime = brief
    ? `${String(brief.generatedAt.getHours()).padStart(2, '0')}.${String(brief.generatedAt.getMinutes()).padStart(2, '0')}`
    : '';
  const eyebrow = brief
    ? `${d.weekdayFull} · ${d.day}. ${d.monthFull} · ${genTime}`
    : `${d.weekdayFull} · ${d.day}. ${d.monthFull}`;

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
          <ActivityIndicator color={papirColor.red} />
        </View>
      ) : !brief ? (
        <View style={{ alignItems: 'center', paddingTop: 70, paddingHorizontal: papirSpace.screen, gap: 12 }}>
          <PaperText role="bodyStrong" color={papirColor.ink2}>
            Ingen briefing endnu
          </PaperText>
          <PaperText role="body" color={papirColor.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>
            Din morgenbriefing lander her hver dag på det tidspunkt, du har valgt.
          </PaperText>
          <Button label="Opdatér" variant="ghost" style={{ paddingHorizontal: 24 }} onPress={() => void refresh()} />
        </View>
      ) : (
        <>
          <View style={{ paddingHorizontal: papirSpace.screen }}>
            <PaperText role="eyebrow" color={papirColor.ink3}>
              {eyebrow}
            </PaperText>
            <PaperText role="displayM" style={{ marginTop: 12 }}>
              {KIND_GREETING[brief.kind]}
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
                  {[...s.followups, ...s.focus].map((line, i) => (
                    <PaperText key={`${i}-${line.slice(0, 24)}`} role="bodySerif" style={{ fontSize: 19, lineHeight: 28, paddingVertical: 4 }}>
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
                <PaperText key={`${i}-${p.slice(0, 24)}`} role="body" color={papirColor.ink2} style={{ paddingVertical: 6 }}>
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
