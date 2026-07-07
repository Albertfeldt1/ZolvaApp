// Papir mail-signature editor - parity with the classic Settings'
// MailSignatureSection plus provider import: Gmail via the official
// sendAs endpoint, Outlook by lifting <div id="Signature"> from recent
// sent mails (Graph has no signature API). Link-target binding for
// imported signatures stays classic-only for now (parity backlog);
// bound targets saved there are preserved and still render here.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Camera, Download, Image as ImageGlyph, Plus, RefreshCw, Trash2 } from 'lucide-react-native';
import {
  Button,
  PaperText,
  papirColor,
  papirRadius,
  papirSpace,
  papirType,
} from '../../design/papir';
import { useConnections } from '../../lib/hooks';
import {
  EMPTY_SIGNATURE,
  buildPreviewHtml,
  fillResultMessage,
  formatImportedDate,
  importResultMessage,
  importSignatureFromGmail,
  importSignatureFromOutlook,
  loadSignature,
  pickAndCompressLogo,
  pickAndFillFields,
  pickAndImportSignature,
  pickAndUseScreenshot,
  pickResultMessage,
  providerImportMessage,
  renderSignature,
  saveSignature,
  subscribeSignature,
  useScreenshotResultMessage,
  type SignatureData,
  type SocialLink,
  type SocialType,
  type StructuredSignature,
} from '../../lib/mail-signature';
import { PushHeader } from './PushHeader';

const SOCIAL_CYCLE: SocialType[] = [
  'linkedin', 'instagram', 'facebook', 'twitter', 'tiktok', 'youtube', 'github', 'website', 'other',
];

const SOCIAL_LABEL: Record<SocialType, string> = {
  linkedin: 'LinkedIn',
  twitter: 'Twitter',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  github: 'GitHub',
  website: 'Website',
  other: 'Andet',
};

function SectionLabel({ children, top = 22 }: { children: string; top?: number }) {
  return (
    <PaperText role="eyebrow" color={papirColor.ink3} style={{ marginTop: top, marginBottom: 10, paddingLeft: 4 }}>
      {children}
    </PaperText>
  );
}

function CardBox({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: papirColor.line,
        borderRadius: papirRadius.xl,
        backgroundColor: papirColor.card,
        padding: 15,
        gap: 12,
      }}
    >
      {children}
    </View>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  editable: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences';
}) {
  return (
    <View>
      <PaperText role="caption" color={papirColor.ink3} style={{ marginBottom: 5 }}>
        {props.label}
      </PaperText>
      <TextInput
        style={[
          papirType.body,
          {
            color: papirColor.ink,
            backgroundColor: papirColor.paper2,
            borderRadius: papirRadius.md,
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: props.multiline ? 84 : undefined,
          },
        ]}
        value={props.value}
        onChangeText={props.onChange}
        onBlur={props.onBlur}
        editable={props.editable}
        multiline={props.multiline}
        keyboardType={props.keyboardType ?? 'default'}
        autoCapitalize={props.autoCapitalize ?? 'sentences'}
        autoCorrect={false}
        textAlignVertical={props.multiline ? 'top' : 'center'}
        placeholderTextColor={papirColor.ink4}
      />
    </View>
  );
}

export function PapirSignature() {
  const connections = useConnections();
  const [data, setData] = useState<SignatureData>(EMPTY_SIGNATURE);
  const [hydrated, setHydrated] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    null | 'gmail' | 'outlook' | 'reproduce' | 'use-image' | 'fill-fields'
  >(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [previewHeight, setPreviewHeight] = useState(260);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  useEffect(() => {
    let cancelled = false;
    void loadSignature().then((s) => {
      if (cancelled) return;
      setData(s ?? EMPTY_SIGNATURE);
      setHydrated(true);
    });
    const unsub = subscribeSignature((s) => {
      if (!cancelled) setData(s ?? EMPTY_SIGNATURE);
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  const grantIntact = (id: string) =>
    connections.data.some((c) => c.id === id && (c.status === 'connected' || c.status === 'stale'));
  const canImportGmail = grantIntact('gmail');
  const canImportOutlook = grantIntact('outlook-mail');

  const update = (patch: Partial<StructuredSignature>) => {
    setData((prev) => {
      if (prev.kind !== 'structured') return prev;
      const next = { ...prev, ...patch };
      void saveSignature(next);
      return next;
    });
  };
  const commit = () => {
    if (!hydrated) return;
    void saveSignature(dataRef.current);
  };

  const adopt = (next: SignatureData) => {
    setData(next);
    void saveSignature(next);
  };

  const onImportFromProvider = async (provider: 'google' | 'microsoft') => {
    setImportError(null);
    setBusyAction(provider === 'google' ? 'gmail' : 'outlook');
    try {
      const result = provider === 'google'
        ? await importSignatureFromGmail()
        : await importSignatureFromOutlook();
      if (!result.ok) {
        setImportError(providerImportMessage(result, provider));
        return;
      }
      adopt(result.data);
    } finally {
      setBusyAction(null);
    }
  };

  const onReproduceFromScreenshot = async () => {
    setImportError(null);
    setBusyAction('reproduce');
    try {
      const result = await pickAndImportSignature();
      if (!result.ok) {
        const msg = importResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      adopt(result.data);
    } finally {
      setBusyAction(null);
    }
  };

  const onUseScreenshotDirectly = async () => {
    setImportError(null);
    setBusyAction('use-image');
    try {
      const result = await pickAndUseScreenshot();
      if (!result.ok) {
        const msg = useScreenshotResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      adopt(result.data);
    } finally {
      setBusyAction(null);
    }
  };

  const onFillFieldsFromScreenshot = async () => {
    setImportError(null);
    setBusyAction('fill-fields');
    try {
      const result = await pickAndFillFields();
      if (!result.ok) {
        const msg = fillResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      // Preserve the existing logo (vision call doesn't touch it). Every
      // other field is replaced - partial merges create surprising mixed
      // states; the user explicitly asked to autofill from this screenshot.
      const existingLogo = data.kind === 'structured' ? data.logo : null;
      adopt({ ...result.data, logo: existingLogo });
    } finally {
      setBusyAction(null);
    }
  };

  const onPickLogo = async () => {
    if (data.kind !== 'structured') return;
    setPickerError(null);
    setPickerBusy(true);
    const result = await pickAndCompressLogo();
    setPickerBusy(false);
    if (!result.ok) {
      const msg = pickResultMessage(result);
      if (msg) setPickerError(msg);
      return;
    }
    adopt({ ...data, logo: result.image });
  };

  const onRemoveLogo = () => {
    if (data.kind !== 'structured') return;
    adopt({ ...data, logo: null });
  };

  const onSwitchToManual = () => {
    Alert.alert('Skift til manuel redigering?', 'Dit importerede design slettes.', [
      { text: 'Annuller', style: 'cancel' },
      { text: 'Skift', style: 'destructive', onPress: () => adopt(EMPTY_SIGNATURE) },
    ]);
  };

  const addSocial = () => {
    setData((prev) => {
      const next: SignatureData = { ...prev, socials: [...prev.socials, { type: 'linkedin', url: '' }] };
      void saveSignature(next);
      return next;
    });
  };

  const updateSocialAt = (idx: number, patch: Partial<SocialLink>) => {
    setData((prev) => {
      const nextSocials = prev.socials.map((s, i) => (i === idx ? { ...s, ...patch } : s));
      const next: SignatureData = { ...prev, socials: nextSocials };
      void saveSignature(next);
      return next;
    });
  };

  const removeSocialAt = (idx: number) => {
    setData((prev) => {
      const next: SignatureData = { ...prev, socials: prev.socials.filter((_, i) => i !== idx) };
      void saveSignature(next);
      return next;
    });
  };

  const cycleSocialType = (idx: number) => {
    const current = data.socials[idx];
    if (!current) return;
    const pos = SOCIAL_CYCLE.indexOf(current.type);
    updateSocialAt(idx, { type: SOCIAL_CYCLE[(pos + 1) % SOCIAL_CYCLE.length] });
  };

  const rendered = data.kind === 'structured' ? renderSignature(data) : null;
  const anyBusy = busyAction !== null;

  const importButton = (opts: {
    key: typeof busyAction;
    label: string;
    busyLabel: string;
    Icon: typeof Download;
    onPress: () => void;
  }) => (
    <Button
      variant="ghost"
      disabled={anyBusy}
      label={busyAction === opts.key ? opts.busyLabel : opts.label}
      left={
        busyAction === opts.key ? (
          <ActivityIndicator size="small" color={papirColor.ink3} />
        ) : (
          <opts.Icon size={16} color={papirColor.ink} strokeWidth={1.8} />
        )
      }
      onPress={opts.onPress}
    />
  );

  const socialsBlock = (
    <>
      <SectionLabel>Links & sociale medier</SectionLabel>
      <CardBox>
        {data.socials.map((s, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable
              onPress={() => cycleSocialType(i)}
              accessibilityRole="button"
              accessibilityLabel={`Skift type: ${SOCIAL_LABEL[s.type]}`}
              style={{
                backgroundColor: papirColor.paper2,
                borderRadius: papirRadius.md,
                paddingHorizontal: 10,
                paddingVertical: 10,
                minWidth: 92,
                alignItems: 'center',
              }}
            >
              <PaperText role="chip" color={papirColor.ink2}>{SOCIAL_LABEL[s.type]}</PaperText>
            </Pressable>
            <TextInput
              style={[
                papirType.body,
                {
                  flex: 1,
                  color: papirColor.ink,
                  backgroundColor: papirColor.paper2,
                  borderRadius: papirRadius.md,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                },
              ]}
              value={s.url}
              onChangeText={(v) => updateSocialAt(i, { url: v })}
              placeholder="https://…"
              placeholderTextColor={papirColor.ink4}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Pressable
              onPress={() => removeSocialAt(i)}
              accessibilityRole="button"
              accessibilityLabel="Fjern link"
              hitSlop={8}
            >
              <Trash2 size={17} color={papirColor.ink3} strokeWidth={1.7} />
            </Pressable>
          </View>
        ))}
        <Pressable
          onPress={addSocial}
          accessibilityRole="button"
          accessibilityLabel="Tilføj link"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 2 }}
        >
          <Plus size={15} color={papirColor.ink2} strokeWidth={2} />
          <PaperText role="bodyStrong" color={papirColor.ink2}>Tilføj link</PaperText>
        </Pressable>
      </CardBox>
    </>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: papirColor.paper }}
      contentContainerStyle={{ paddingBottom: 60, paddingHorizontal: papirSpace.screen }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ marginHorizontal: -papirSpace.screen }}>
        <PushHeader title="Mail-signatur" />
      </View>

      <PaperText role="body" color={papirColor.ink2}>
        Bruges ved mails sendt fra Outlook (og iCloud, når mail-afsendelse fra Zolva er tilføjet senere).
        Gmail bruger den signatur, du allerede har sat op i Gmail-indstillingerne.
      </PaperText>

      <SectionLabel>Hent din eksisterende signatur</SectionLabel>
      <View style={{ gap: 8 }}>
        {canImportGmail
          ? importButton({
              key: 'gmail',
              label: 'Hent fra Gmail',
              busyLabel: 'Henter fra Gmail…',
              Icon: Download,
              onPress: () => void onImportFromProvider('google'),
            })
          : null}
        {canImportOutlook
          ? importButton({
              key: 'outlook',
              label: 'Hent fra Outlook',
              busyLabel: 'Leder i sendte mails…',
              Icon: Download,
              onPress: () => void onImportFromProvider('microsoft'),
            })
          : null}
        {importButton({
          key: 'reproduce',
          label: 'Reproducér fra screenshot',
          busyLabel: 'Reproducerer signatur…',
          Icon: Camera,
          onPress: () => void onReproduceFromScreenshot(),
        })}
        {importButton({
          key: 'use-image',
          label: 'Brug screenshot som billede',
          busyLabel: 'Indlæser billede…',
          Icon: ImageGlyph,
          onPress: () => void onUseScreenshotDirectly(),
        })}
      </View>
      {importError ? (
        <PaperText role="small" color={papirColor.red} style={{ marginTop: 8 }}>
          {importError}
        </PaperText>
      ) : null}

      {data.kind === 'structured' ? (
        <>
          <SectionLabel>Udfyld selv</SectionLabel>
          <CardBox>
            {importButton({
              key: 'fill-fields',
              label: 'Udfyld felter fra screenshot',
              busyLabel: 'Læser felter…',
              Icon: Camera,
              onPress: () => void onFillFieldsFromScreenshot(),
            })}
            <Field label="Navn" value={data.name} onChange={(v) => update({ name: v })} onBlur={commit} editable={hydrated} />
            <Field label="Titel" value={data.title} onChange={(v) => update({ title: v })} onBlur={commit} editable={hydrated} />
            <Field label="Virksomhed" value={data.company} onChange={(v) => update({ company: v })} onBlur={commit} editable={hydrated} />
            <Field label="Telefon" value={data.phone} onChange={(v) => update({ phone: v })} onBlur={commit} editable={hydrated} keyboardType="phone-pad" />
            <Field label="Email" value={data.email} onChange={(v) => update({ email: v })} onBlur={commit} editable={hydrated} keyboardType="email-address" autoCapitalize="none" />
            <Field label="Website" value={data.website} onChange={(v) => update({ website: v })} onBlur={commit} editable={hydrated} autoCapitalize="none" />
            <Field label="Egne linjer" value={data.customLines} onChange={(v) => update({ customLines: v })} onBlur={commit} editable={hydrated} multiline />
            <PaperText role="caption" color={papirColor.ink3}>
              Tip: lav et klikbart link med [tekst](url) - fx Læs vores [privatlivspolitik](zolva.io/privacy).
            </PaperText>
          </CardBox>

          <SectionLabel>Logo</SectionLabel>
          <CardBox>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              {data.logo ? (
                <>
                  <Image
                    source={{ uri: `data:${data.logo.mimeType};base64,${data.logo.base64}` }}
                    style={{ width: 56, height: 56, borderRadius: papirRadius.md }}
                    resizeMode="contain"
                  />
                  <Button variant="ghost" label="Fjern" onPress={onRemoveLogo} style={{ flex: 1 }} />
                </>
              ) : (
                <Button
                  variant="ghost"
                  label={pickerBusy ? 'Indlæser…' : 'Vælg billede'}
                  disabled={pickerBusy}
                  onPress={() => void onPickLogo()}
                  style={{ flex: 1 }}
                />
              )}
            </View>
            {pickerError ? (
              <PaperText role="small" color={papirColor.red}>{pickerError}</PaperText>
            ) : null}
          </CardBox>

          {socialsBlock}

          <SectionLabel>Forhåndsvisning</SectionLabel>
          <CardBox>
            {rendered ? (
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {data.logo ? (
                  <Image
                    source={{ uri: `data:${data.logo.mimeType};base64,${data.logo.base64}` }}
                    style={{ width: 48, height: 48 }}
                    resizeMode="contain"
                  />
                ) : null}
                <View style={{ flex: 1, gap: 2 }}>
                  {[data.name, data.title].filter(Boolean).length ? (
                    <PaperText role="bodyStrong">{[data.name, data.title].filter(Boolean).join(' · ')}</PaperText>
                  ) : null}
                  {data.company ? <PaperText role="body">{data.company}</PaperText> : null}
                  {[data.phone ? `T: ${data.phone}` : '', data.email].filter(Boolean).length ? (
                    <PaperText role="body">{[data.phone ? `T: ${data.phone}` : '', data.email].filter(Boolean).join(' · ')}</PaperText>
                  ) : null}
                  {data.website ? <PaperText role="body">{data.website}</PaperText> : null}
                  {data.customLines.trim() ? <PaperText role="body">{data.customLines}</PaperText> : null}
                </View>
              </View>
            ) : (
              <PaperText role="body" color={papirColor.ink3}>
                Udfyld felterne ovenfor for at se en forhåndsvisning.
              </PaperText>
            )}
          </CardBox>
        </>
      ) : (
        <>
          <SectionLabel>Forhåndsvisning</SectionLabel>
          <CardBox>
            <View style={{ height: previewHeight, borderRadius: papirRadius.md, overflow: 'hidden' }}>
              <WebView
                key={previewKey}
                originWhitelist={['*']}
                javaScriptEnabled
                scrollEnabled={false}
                source={{ html: buildPreviewHtml(data) }}
                style={{ backgroundColor: 'transparent' }}
                injectedJavaScript={`(function(){function post(){try{window.ReactNativeWebView.postMessage(String(Math.ceil(document.body.scrollHeight)));}catch(e){}}post();window.addEventListener('load',post);setTimeout(post,80);setTimeout(post,300);})();true;`}
                onMessage={(event) => {
                  const h = parseInt(event.nativeEvent.data, 10);
                  if (Number.isFinite(h) && h > 60 && h < 900) {
                    setPreviewHeight(h);
                  }
                }}
                onShouldStartLoadWithRequest={(req) => {
                  // Allow only the inline HTML's initial load. User-tapped
                  // links go to the system browser instead of navigating
                  // away from the inline page (which would render blank).
                  if (req.navigationType === 'click') {
                    void Linking.openURL(req.url);
                    return false;
                  }
                  return true;
                }}
              />
            </View>
            <Pressable
              onPress={() => setPreviewKey((k) => k + 1)}
              accessibilityRole="button"
              accessibilityLabel="Genindlæs forhåndsvisning"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <RefreshCw size={13} color={papirColor.ink3} strokeWidth={2.2} />
              <PaperText role="small" color={papirColor.ink3}>Genindlæs forhåndsvisning</PaperText>
            </Pressable>
            {data.importedAt ? (
              <PaperText role="caption" color={papirColor.ink3}>
                {`Importeret ${formatImportedDate(data.importedAt)}`}
              </PaperText>
            ) : null}
          </CardBox>

          {socialsBlock}

          <View style={{ marginTop: 18 }}>
            <Button variant="ghost" label="Skift til manuel redigering" onPress={onSwitchToManual} />
          </View>
        </>
      )}
    </ScrollView>
  );
}
