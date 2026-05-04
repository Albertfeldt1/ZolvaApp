// EXPORT_PATH_DOCUMENTED — The previous "Eksportér alle data" button rendered a
// fake Alert. It was removed (see comment in the Privatliv card below) because a
// broken promise is a GDPR Art. 15 liability. The right-of-access path now lives
// in the privacy policy (owned by T3 in legal/privacy-policy-{da,en}.md): users
// email the contact address and Zolva responds within 30 days. When/if a real
// JSON export is built (Edge Function + Resend), re-add a button here and grep
// for this marker to update the handoff.
import { Check, ChevronDown, ChevronLeft, Globe, Image as ImageIcon, Link2Off, Plus, RefreshCw, X } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import { WebView } from 'react-native-webview';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageSourcePropType,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
import { makeRedirectUri } from 'expo-auth-session';
import { LiquidToggle } from '../components/LiquidToggle';
import { useChromeInsets } from '../components/PhoneChrome';
import { Stone } from '../components/Stone';
import { TopRightActions } from '../components/TopRightActions';
import { useAuth } from '../lib/auth';
import {
  useCalendarLabels,
  useConnections,
  usePrivacyToggles,
  useSubscription,
  useUser,
  useWorkPreferences,
} from '../lib/hooks';
import { listWritableCalendars, type ProviderCalendar } from '../lib/calendar-providers';
import type { CalendarLabelKey } from '../lib/calendar-labels';
import { supabase } from '../lib/supabase';
import type { Connection, IntegrationStatus, WorkPreference } from '../lib/types';
import { clearCredential, loadCredential } from '../lib/icloud-credentials';
import { clearDiscoveryCacheFor } from '../lib/icloud-calendar';
import { clearBinding as clearIcloudBinding } from '../lib/icloud-mail';
import {
  loadSignature,
  saveSignature,
  subscribeSignature,
  pickAndCompressLogo,
  pickResultMessage,
  pickAndImportSignature,
  importResultMessage,
  renderSignature,
  EMPTY_SIGNATURE,
  type SignatureData,
  type StructuredSignature,
  type SocialLink,
  type SocialType,
  type LinkTarget,
  type InlineImage,
} from '../lib/mail-signature';
import { detectImportedTargets, type DetectedTargets } from '../lib/mail-signature/detect-targets';
import { applyBoundTargets } from '../lib/mail-signature/apply-bound-targets';
import { renderSocials } from '../lib/mail-signature/template';
import { translateProviderError } from '../utils/danish';

import {
  ensurePermission,
  getPermissionStatus,
  syncOnAppForeground,
  type PermissionStatus,
} from '../lib/notifications';
import {
  getNotificationSettings,
  setNotificationSetting,
  subscribeNotificationSettings,
  type NotificationSettings,
} from '../lib/notification-settings';
import {
  registerPushToken,
  setMailWatchersEnabled,
  unregisterPushToken,
} from '../lib/push';
import { DeleteAccountScreen } from './DeleteAccountScreen';
import { IcloudBriefSheet } from '../components/IcloudBriefSheet';
import { colors, fonts } from '../theme';

// Reads the hosted privacy-policy URL from app.json extra.privacyPolicyUrl
// so legal copy can be swapped without a new binary. Returns null while
// the URL is still a placeholder (so the link gracefully no-ops in dev).
function getPrivacyPolicyUrl(): string | null {
  const raw = Constants.expoConfig?.extra?.privacyPolicyUrl;
  if (typeof raw !== 'string') return null;
  if (!raw || raw.startsWith('TODO_')) return null;
  return raw;
}

const ROW_TRANSITION = LinearTransition.duration(220);
const OPTIONS_ENTER = FadeIn.duration(180);
const OPTIONS_EXIT = FadeOut.duration(140);
const COLLAPSE_EASING = Easing.bezier(0.22, 1, 0.36, 1);
// Slower than ROW_TRANSITION so the height interpolation has time to push the
// next section down before the body becomes visible — without it, the body
// renders at full size for a frame and overlaps the section below.
const COLLAPSE_TRANSITION = LinearTransition.duration(320);
const COLLAPSE_BODY_ENTER = FadeIn.duration(260).delay(60);
const COLLAPSE_BODY_EXIT = FadeOut.duration(140);

function CollapsibleSection({
  title,
  defaultOpen = false,
  paddingTop,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  paddingTop?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const rotation = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    rotation.value = withTiming(open ? 1 : 0, { duration: 260, easing: COLLAPSE_EASING });
  }, [open, rotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 180}deg` }],
  }));

  return (
    <Animated.View
      layout={COLLAPSE_TRANSITION}
      style={[
        styles.section,
        // overflow: hidden clips the body during the height transition so it
        // can't bleed into the section below mid-animation.
        styles.sectionClip,
        paddingTop != null ? { paddingTop } : null,
      ]}
    >
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.collapseHeader}
        hitSlop={6}
      >
        <Text style={styles.sectionTitle}>{title}</Text>
        <Animated.View style={chevronStyle}>
          <ChevronDown size={20} color={colors.ink} strokeWidth={2.2} />
        </Animated.View>
      </Pressable>
      <View style={styles.inkRule} />
      {open ? (
        <Animated.View
          entering={COLLAPSE_BODY_ENTER}
          exiting={COLLAPSE_BODY_EXIT}
        >
          {children}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const LOGOS: Record<string, ImageSourcePropType> = {
  'google-calendar.png': require('../../assets/logos/google-calendar.png'),
  'gmail.png': require('../../assets/logos/gmail.png'),
  'google-drive.png': require('../../assets/logos/google-drive.png'),
  'outlook-calendar.png': require('../../assets/logos/outlook-calendar.png'),
  'outlook-mail.png': require('../../assets/logos/outlook-mail.png'),
  'icloud.png': require('../../assets/logos/icloud.png'),
  'slack.png': require('../../assets/logos/slack.png'),
  'notion.png': require('../../assets/logos/notion.png'),
};

// Placeholder integrations shown greyed out under "Forbundet" — no auth or
// status yet, so they live outside the Connection type / useConnections store.
const COMING_SOON_INTEGRATIONS: { key: string; title: string; sub: string; logo: string }[] = [
  { key: 'slack', title: 'Slack', sub: 'Beskeder og kanaler', logo: 'slack.png' },
  { key: 'notion', title: 'Notion', sub: 'Noter og dokumenter', logo: 'notion.png' },
];

const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: 'Forbundet',
  pending: 'Venter',
  expired: 'Genindtast adgangskode',
  disconnected: 'Ikke forbundet',
};

function useNotificationSettings(): NotificationSettings {
  const [state, setState] = useState<NotificationSettings>(getNotificationSettings());
  useEffect(() => subscribeNotificationSettings(setState), []);
  return state;
}

function buildPreviewHtml(sig: {
  html: string;
  image: { base64: string; mimeType: 'image/png' | 'image/jpeg' } | null;
  socials: SocialLink[];
}): string {
  // Apply any bound targets to the imported html (mirror the buildOutgoingBody
  // path) so the preview reflects what recipients will actually see — the
  // socials with target.set become inline anchors in the html, and the
  // remaining unbound socials get appended as a separate row.
  const applied = applyBoundTargets({ html: sig.html, socials: sig.socials });
  const socialsRow = renderSocials(applied.unbound);
  let combined = applied.html + socialsRow;

  // Resolve cid:zolva-sig to a data URL so the WebView preview renders the
  // cropped logo without an external load. The outgoing-mail path keeps cid:
  // as-is — this transformation is preview-only.
  if (sig.image) {
    const cidDataUrl = `data:${sig.image.mimeType};base64,${sig.image.base64}`;
    combined = combined.replaceAll('cid:zolva-sig', cidDataUrl);
  }

  // Render the signature at a fixed 600 px logical width so wide CTA buttons
  // don't reflow into a squished multi-line shape inside the narrow preview
  // pane. The WebView scales the 600 px page down to fit its actual width,
  // giving a true "thumbnail" of how the email looks at email-client width.
  // Viewport ~420 logical px keeps content at email-client proportions
  // (CTA buttons stay side-by-side without wrapping) while landing at
  // ~0.8× of the actual WebView width — content renders large and
  // close to its natural size. Body padding kept tight (4 px) so the
  // signature fills the preview pane edge-to-edge.
  return `<!doctype html><html><head><meta name="viewport" content="width=420,initial-scale=0.81,user-scalable=no"><style>html,body{margin:0;padding:4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:transparent;}img{max-width:100%;height:auto;}</style></head><body>${combined}</body></html>`;
}

function formatImportedDate(unixMs: number): string {
  if (!unixMs) return '';
  const d = new Date(unixMs);
  try {
    return new Intl.DateTimeFormat('da-DK', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

type SocialMeta = {
  label: string;
  glyph: string;       // letter monogram or unicode mark — fallback when no asset
  bg: string;          // brand background color (used when rendering the glyph circle)
  fg: string;          // glyph foreground color
  placeholder: string; // url input hint
  gradient?: readonly string[]; // optional brand gradient (Instagram fallback)
  useGlobeIcon?: boolean; // when true, BrandIcon renders the Globe lucide icon instead of the glyph
  asset?: ImageSourcePropType; // pre-rendered brand-icon PNG (preferred over glyph when set)
  assetScale?: number; // multiplier for the rendered asset relative to the requested size — used when the source PNG has extra transparent padding (e.g. Instagram).
};

const SOCIAL_META: Record<SocialType, SocialMeta> = {
  linkedin:  { label: 'LinkedIn',  glyph: 'in',  bg: '#0a66c2', fg: '#ffffff', placeholder: 'linkedin.com/in/…',
               asset: require('../../assets/socials/linkedin.png'),
               assetScale: 0.92 },
  twitter:   { label: 'X / Twitter', glyph: '𝕏', bg: '#000000', fg: '#ffffff', placeholder: 'x.com/…',
               asset: require('../../assets/socials/twitter.png'),
               assetScale: 0.92 },
  instagram: { label: 'Instagram', glyph: 'Ig',  bg: '#e4405f', fg: '#ffffff', placeholder: 'instagram.com/…',
               gradient: ['#833ab4', '#fd1d1d', '#fcb045'],
               asset: require('../../assets/socials/instagram.png'),
               assetScale: 1.35 },
  facebook:  { label: 'Facebook',  glyph: 'f',   bg: '#1877f2', fg: '#ffffff', placeholder: 'facebook.com/…',
               asset: require('../../assets/socials/facebook.png') },
  tiktok:    { label: 'TikTok',    glyph: 'T',   bg: '#000000', fg: '#ffffff', placeholder: 'tiktok.com/@…',
               asset: require('../../assets/socials/tiktok.png') },
  youtube:   { label: 'YouTube',   glyph: '▶',   bg: '#ff0000', fg: '#ffffff', placeholder: 'youtube.com/@…',
               asset: require('../../assets/socials/youtube.png') },
  github:    { label: 'GitHub',    glyph: 'Gh',  bg: '#1a1a1a', fg: '#ffffff', placeholder: 'github.com/…',
               asset: require('../../assets/socials/github.png') },
  website:   { label: 'Website',   glyph: '',    bg: '#3a7afe', fg: '#ffffff', placeholder: 'https://…',  useGlobeIcon: true },
  other:     { label: 'Andet',     glyph: '•',   bg: '#777777', fg: '#ffffff', placeholder: 'https://…' },
};

const SOCIAL_TYPES: SocialType[] = [
  'linkedin', 'twitter', 'instagram', 'facebook',
  'tiktok', 'youtube', 'github', 'website', 'other',
];

function BrandIcon({ type, size = 36 }: { type: SocialType; size?: number }) {
  const meta = SOCIAL_META[type];
  const radius = size / 2;
  const fontSize = size <= 28 ? size * 0.42 : size * 0.4;

  // Preferred path: pre-rendered brand-icon PNG. The asset already includes
  // the colored circle, so we just render the image. The outer box stays at
  // the requested `size` so every BrandIcon occupies the same row/wheel
  // slot regardless of brand. assetScale only adjusts the visual size of
  // the inner image — Instagram's transparent padding gets compensated
  // without misaligning the layout of its peers.
  if (meta.asset) {
    const renderedSize = size * (meta.assetScale ?? 1);
    return (
      <View
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'visible',
        }}
      >
        <Image
          source={meta.asset}
          style={{ width: renderedSize, height: renderedSize }}
          resizeMode="contain"
        />
      </View>
    );
  }

  const inner = meta.useGlobeIcon ? (
    <Globe size={Math.round(size * 0.5)} color={meta.fg} strokeWidth={2.2} />
  ) : (
    <Text
      style={{
        color: meta.fg,
        fontSize,
        fontWeight: '800',
        letterSpacing: -0.5,
        includeFontPadding: false,
        textAlign: 'center',
      }}
    >
      {meta.glyph}
    </Text>
  );

  if (meta.gradient) {
    return (
      <LinearGradient
        colors={[...meta.gradient] as [string, string, ...string[]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ width: size, height: size, borderRadius: radius, alignItems: 'center', justifyContent: 'center' }}
      >
        {inner}
      </LinearGradient>
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: meta.bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {inner}
    </View>
  );
}

// Radial petal — fans outward from the wheel center on bloom-in.
const WHEEL_RADIUS = 138;
const WHEEL_PETAL_BOX = 78;

function WheelPetal(props: {
  type: SocialType;
  selected: boolean;
  index: number;
  total: number;
  progress: SharedValue<number>;
  onPress: () => void;
}) {
  const { type, selected, index, total, progress, onPress } = props;
  const meta = SOCIAL_META[type];
  // Stagger window: each petal fully blooms over a 60% slice of progress,
  // shifted by its index. Earlier petals lead by ~50ms-equivalent at the
  // spring's natural cadence.
  const start = (index / total) * 0.35;
  const end = start + 0.65;
  const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
  const tx = Math.cos(angle) * WHEEL_RADIUS;
  const ty = Math.sin(angle) * WHEEL_RADIUS;

  const animStyle = useAnimatedStyle(() => {
    const raw = (progress.value - start) / (end - start);
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    return {
      opacity: t,
      transform: [
        { translateX: tx * t },
        { translateY: ty * t },
        { scale: 0.4 + 0.6 * t },
      ],
    };
  });

  return (
    <AnimatedPressable
      onPress={onPress}
      style={[styles.sigWheelPetal, animStyle]}
      accessibilityRole="button"
      accessibilityLabel={meta.label}
    >
      <View style={selected ? styles.sigWheelPetalIconRingSelected : styles.sigWheelPetalIconRing}>
        <BrandIcon type={type} size={44} />
      </View>
      <Text style={styles.sigWheelPetalLabel} numberOfLines={1}>{meta.label}</Text>
    </AnimatedPressable>
  );
}

function SocialTypeWheel(props: {
  visible: boolean;
  value: SocialType;
  onSelect: (next: SocialType) => void;
  onClose: () => void;
}) {
  const { visible, value, onSelect, onClose } = props;
  const progress = useSharedValue(0);
  const seedScale = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      progress.value = 0;
      seedScale.value = 0;
      // The seed pops first, then the wheel blooms outward.
      seedScale.value = withSpring(1, { damping: 13, stiffness: 220 });
      progress.value = withSpring(1, { damping: 14, stiffness: 110, mass: 1.1 });
    } else {
      progress.value = withTiming(0, { duration: 180, easing: Easing.in(Easing.cubic) });
      seedScale.value = withTiming(0, { duration: 140, easing: Easing.in(Easing.cubic) });
    }
  }, [visible, progress, seedScale]);

  const seedStyle = useAnimatedStyle(() => ({
    opacity: seedScale.value * (1 - progress.value * 0.7), // fades as petals bloom
    transform: [{ scale: seedScale.value }],
  }));

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Luk vælger">
        <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
      </Pressable>
      <View style={styles.sigWheelStage} pointerEvents="box-none">
        <View style={styles.sigWheelOrigin} pointerEvents="box-none">
          <Animated.View style={[styles.sigWheelSeed, seedStyle]} pointerEvents="none" />
          {SOCIAL_TYPES.map((type, i) => (
            <WheelPetal
              key={type}
              type={type}
              selected={type === value}
              index={i}
              total={SOCIAL_TYPES.length}
              progress={progress}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onSelect(type);
                onClose();
              }}
            />
          ))}
        </View>
      </View>
    </Modal>
  );
}

function WordChip(props: { word: string; selected: boolean; onPress: () => void }) {
  const { word, selected, onPress } = props;
  const press = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => { press.value = withSpring(0.92, { damping: 14, stiffness: 320 }); }}
      onPressOut={() => { press.value = withSpring(1, { damping: 14, stiffness: 320 }); }}
      style={[styles.sigBindWordChip, selected && styles.sigBindWordChipSelected, pressStyle]}
      accessibilityRole="button"
      accessibilityLabel={`Bind til ord ${word}`}
    >
      <Text style={[styles.sigBindWordChipText, selected && styles.sigBindWordChipTextSelected]} numberOfLines={1}>
        {word}
      </Text>
    </AnimatedPressable>
  );
}

function ImageBindOption(props: {
  src: string;
  description: string;
  thumbnail?: InlineImage;
  selected: boolean;
  onPress: () => void;
}) {
  const { description, thumbnail, selected, onPress } = props;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.sigBindImageRow, selected && styles.sigBindImageRowSelected]}
      accessibilityRole="button"
    >
      <View style={styles.sigBindImageThumb}>
        {thumbnail ? (
          <Image
            source={{ uri: `data:${thumbnail.mimeType};base64,${thumbnail.base64}` }}
            style={styles.sigBindImageThumbImg}
            resizeMode="contain"
          />
        ) : (
          <ImageIcon size={18} color={colors.fg3} strokeWidth={2} />
        )}
      </View>
      <Text style={styles.sigBindImageDesc} numberOfLines={1}>{description}</Text>
      {selected && <Check size={16} color={colors.ink} strokeWidth={2.5} />}
    </Pressable>
  );
}

function SocialBindPicker(props: {
  visible: boolean;
  target: LinkTarget | undefined;
  targets: DetectedTargets;
  imageThumbnails: Record<string, InlineImage>;
  onSelect: (next: LinkTarget | undefined) => void;
  onClose: () => void;
}) {
  const { visible, target, targets, imageThumbnails, onSelect, onClose } = props;
  const isEmpty =
    targets.words.length === 0 &&
    targets.glyphs.length === 0 &&
    targets.buttons.length === 0 &&
    targets.images.length === 0;

  const handleSelect = (next: LinkTarget | undefined) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSelect(next);
    onClose();
  };

  const isVisSeparat = target == null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.paperOn75 }]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Luk Bind til-vælger"
      />
      <View style={styles.sigBindFloatWrap} pointerEvents="box-none">
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(140)}
          style={styles.sigBindFloat}
        >
          <Text style={styles.sigBindSheetTitle}>Bind til element</Text>
          <Text style={styles.sigBindSheetSub}>Vælg et ord eller billede i signaturen.</Text>

          <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
            {/* Unbind option — distinct full-width pill with link-off icon */}
            <Pressable
              onPress={() => handleSelect(undefined)}
              style={[styles.sigBindUnbindPill, isVisSeparat && styles.sigBindUnbindPillSelected]}
              accessibilityRole="button"
            >
              <Link2Off size={15} color={isVisSeparat ? '#fff' : colors.fg2} strokeWidth={2.2} />
              <Text style={[styles.sigBindUnbindPillText, isVisSeparat && styles.sigBindUnbindPillTextSelected]}>
                Vis som separat link
              </Text>
            </Pressable>

            {isEmpty ? (
              <View style={styles.sigBindEmptyState}>
                <Text style={styles.sigBindEmptyEmoji}>🔍</Text>
                <Text style={styles.sigBindEmptyTitle}>Ingen elementer fundet</Text>
                <Text style={styles.sigBindEmptyHint}>
                  Importér et tydeligere screenshot for at få bind-muligheder.
                </Text>
              </View>
            ) : (
              <>
                {targets.buttons.length > 0 && (
                  <>
                    <Text style={styles.sigBindSectionLabel}>KNAPPER</Text>
                    <View style={styles.sigBindButtonsCol}>
                      {targets.buttons.map((btn) => {
                        const selected = target?.kind === 'word' && target.text === btn.text;
                        return (
                          <Pressable
                            key={btn.text}
                            onPress={() => handleSelect({ kind: 'word', text: btn.text })}
                            style={[styles.sigBindButtonRow, selected && styles.sigBindButtonRowSelected]}
                            accessibilityRole="button"
                          >
                            <View
                              style={[
                                styles.sigBindButtonChip,
                                { backgroundColor: btn.bgColor },
                              ]}
                            >
                              <Text style={styles.sigBindButtonChipText} numberOfLines={1}>
                                {btn.text}
                              </Text>
                            </View>
                            {selected && <Check size={16} color={colors.ink} strokeWidth={2.5} />}
                          </Pressable>
                        );
                      })}
                    </View>
                  </>
                )}
                {targets.words.length > 0 && (
                  <>
                    <Text style={[styles.sigBindSectionLabel, targets.buttons.length > 0 && { marginTop: 18 }]}>
                      ORD I SIGNATUREN
                    </Text>
                    <View style={styles.sigBindWordWrap}>
                      {targets.words.map((word) => (
                        <WordChip
                          key={word}
                          word={word}
                          selected={target?.kind === 'word' && target.text === word}
                          onPress={() => handleSelect({ kind: 'word', text: word })}
                        />
                      ))}
                    </View>
                  </>
                )}
                {(targets.glyphs.length > 0 || targets.images.length > 0) && (
                  <>
                    <Text style={[styles.sigBindSectionLabel, { marginTop: 18 }]}>BILLEDER</Text>
                    {/* Glyphs first — single-char/symbol icon stand-ins.
                        Bound the same way as words (kind:'word') but rendered
                        here as a wrap-flow of small chips for visual parity
                        with the image rows below. */}
                    {targets.glyphs.length > 0 && (
                      <View style={styles.sigBindWordWrap}>
                        {targets.glyphs.map((glyph) => (
                          <WordChip
                            key={glyph}
                            word={glyph}
                            selected={target?.kind === 'word' && target.text === glyph}
                            onPress={() => handleSelect({ kind: 'word', text: glyph })}
                          />
                        ))}
                      </View>
                    )}
                    {targets.images.map((img) => (
                      <ImageBindOption
                        key={img.src}
                        src={img.src}
                        description={img.description}
                        thumbnail={imageThumbnails[img.src]}
                        selected={target?.kind === 'image' && target.src === img.src}
                        onPress={() => handleSelect({ kind: 'image', src: img.src })}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

function bindPillLabel(target: LinkTarget | undefined): string {
  if (target == null) return 'Vis separat';
  if (target.kind === 'word') {
    const truncated = target.text.length > 16 ? target.text.slice(0, 16) + '…' : target.text;
    return `↪ "${truncated}"`;
  }
  return '↪ Billede';
}

function SocialLinkRow(props: {
  link: SocialLink;
  mode: 'structured' | 'imported';
  targets: DetectedTargets;
  imageThumbnails: Record<string, InlineImage>;
  onChange: (next: SocialLink) => void;
  onRemove: () => void;
}) {
  const { link, mode, targets, imageThumbnails, onChange, onRemove } = props;
  const [pickerVisible, setPickerVisible] = useState(false);
  const [bindPickerVisible, setBindPickerVisible] = useState(false);
  const meta = SOCIAL_META[link.type];

  const removeScale = useSharedValue(1);
  const brandScale = useSharedValue(1);
  const removeStyle = useAnimatedStyle(() => ({ transform: [{ scale: removeScale.value }] }));
  const brandStyle = useAnimatedStyle(() => ({ transform: [{ scale: brandScale.value }] }));

  const isBound = link.target != null;

  return (
    <Animated.View
      entering={FadeInDown.springify().damping(16).stiffness(180)}
      exiting={FadeOut.duration(160)}
      layout={LinearTransition.springify().damping(18).stiffness(200)}
      style={styles.sigSocialRow}
    >
      <AnimatedPressable
        onPressIn={() => { brandScale.value = withSpring(0.92, { damping: 14, stiffness: 320 }); }}
        onPressOut={() => { brandScale.value = withSpring(1, { damping: 14, stiffness: 320 }); }}
        onPress={() => {
          void Haptics.selectionAsync();
          setPickerVisible(true);
        }}
        style={[styles.sigSocialBrandBtn, brandStyle]}
        accessibilityRole="button"
        accessibilityLabel={`Skift platform fra ${meta.label}`}
      >
        <BrandIcon type={link.type} size={36} />
      </AnimatedPressable>

      <View style={styles.sigSocialInputs}>
        <TextInput
          value={link.url}
          onChangeText={(url) => onChange({ ...link, url })}
          placeholder={meta.placeholder}
          placeholderTextColor={colors.fg3}
          style={styles.sigSocialUrlInput}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {link.type === 'other' && (
          <TextInput
            value={link.label ?? ''}
            onChangeText={(label) => onChange({ ...link, label })}
            placeholder="Visningsnavn"
            placeholderTextColor={colors.fg3}
            style={styles.sigSocialLabelInput}
          />
        )}
        {mode === 'imported' && (
          <Pressable
            onPress={() => setBindPickerVisible(true)}
            style={[styles.sigBindPill, isBound ? styles.sigBindPillBound : styles.sigBindPillUnbound]}
            accessibilityRole="button"
            accessibilityLabel="Bind til element i signatur"
          >
            <Text style={styles.sigBindPillText} numberOfLines={1}>{bindPillLabel(link.target)}</Text>
          </Pressable>
        )}
      </View>

      <AnimatedPressable
        onPressIn={() => { removeScale.value = withSpring(0.85, { damping: 12, stiffness: 320 }); }}
        onPressOut={() => { removeScale.value = withSpring(1, { damping: 12, stiffness: 320 }); }}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onRemove();
        }}
        style={[styles.sigSocialRemoveBtn, removeStyle]}
        accessibilityRole="button"
        accessibilityLabel="Fjern social-medie"
      >
        <X size={14} color={colors.fg2} strokeWidth={2.5} />
      </AnimatedPressable>

      <SocialTypeWheel
        visible={pickerVisible}
        value={link.type}
        onSelect={(type) => onChange({ ...link, type })}
        onClose={() => setPickerVisible(false)}
      />

      <SocialBindPicker
        visible={bindPickerVisible}
        target={link.target}
        targets={targets}
        imageThumbnails={imageThumbnails}
        onSelect={(next) => onChange({ ...link, target: next })}
        onClose={() => setBindPickerVisible(false)}
      />
    </Animated.View>
  );
}

function SocialsSection(props: {
  socials: SocialLink[];
  mode: 'structured' | 'imported';
  targets: DetectedTargets;
  imageThumbnails: Record<string, InlineImage>;
  onUpdate: (idx: number, link: SocialLink) => void;
  onRemove: (idx: number) => void;
  onAdd: () => void;
}) {
  const { socials, mode, targets, imageThumbnails, onUpdate, onRemove, onAdd } = props;
  const addScale = useSharedValue(1);
  const addStyle = useAnimatedStyle(() => ({ transform: [{ scale: addScale.value }] }));
  const isEmpty = socials.length === 0;

  return (
    <View style={styles.sigSocialsWrap}>
      <View style={styles.sigSocialsHeader}>
        <Text style={styles.sigFieldLabel}>Sociale medier</Text>
        {!isEmpty && (
          <View style={styles.sigSocialsCountPill}>
            <Text style={styles.sigSocialsCountText}>{socials.length}</Text>
          </View>
        )}
      </View>

      {socials.map((link, idx) => (
        <SocialLinkRow
          key={idx}
          link={link}
          mode={mode}
          targets={targets}
          imageThumbnails={imageThumbnails}
          onChange={(next) => onUpdate(idx, next)}
          onRemove={() => onRemove(idx)}
        />
      ))}

      <AnimatedPressable
        onPressIn={() => { addScale.value = withSpring(0.97, { damping: 14, stiffness: 320 }); }}
        onPressOut={() => { addScale.value = withSpring(1, { damping: 14, stiffness: 320 }); }}
        onPress={() => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onAdd();
        }}
        style={[styles.sigSocialAddBtn, isEmpty && styles.sigSocialAddBtnEmpty, addStyle]}
        accessibilityRole="button"
      >
        <View style={styles.sigSocialAddPlus}>
          <Plus size={14} color={colors.ink} strokeWidth={2.5} />
        </View>
        <Text style={styles.sigSocialAddBtnText}>
          {isEmpty ? 'Tilføj sociale medier' : 'Tilføj endnu et'}
        </Text>
      </AnimatedPressable>
    </View>
  );
}

// Manual mail signature — structured form with optional logo. Renders
// as HTML in Outlook send paths (and iCloud SMTP when that lands).
// Gmail still uses the auto-fetched server signature.
function MailSignatureSection() {
  const [data, setData] = useState<SignatureData>(EMPTY_SIGNATURE);
  const [hydrated, setHydrated] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
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
    const next = { ...data, logo: result.image };
    setData(next);
    void saveSignature(next);
  };

  const onRemoveLogo = () => {
    if (data.kind !== 'structured') return;
    const next = { ...data, logo: null };
    setData(next);
    void saveSignature(next);
  };

  const onImportFromScreenshot = async () => {
    setImportError(null);
    setImporting(true);
    try {
      const result = await pickAndImportSignature();
      if (!result.ok) {
        const msg = importResultMessage(result);
        if (msg) setImportError(msg);
        return;
      }
      setData(result.data);
      void saveSignature(result.data);
    } finally {
      setImporting(false);
    }
  };

  const onSwitchToManual = () => {
    Alert.alert(
      'Skift til manuel redigering?',
      'Dit importerede design slettes.',
      [
        { text: 'Annuller', style: 'cancel' },
        {
          text: 'Skift',
          style: 'destructive',
          onPress: () => {
            setData(EMPTY_SIGNATURE);
            void saveSignature(EMPTY_SIGNATURE);
          },
        },
      ],
    );
  };

  const addSocial = () => {
    setData((prev) => {
      const next: SignatureData = {
        ...prev,
        socials: [...prev.socials, { type: 'linkedin', url: '' }],
      };
      void saveSignature(next);
      return next;
    });
  };

  const updateSocialAt = (idx: number, link: SocialLink) => {
    setData((prev) => {
      const nextSocials = prev.socials.map((s, i) => (i === idx ? link : s));
      const next: SignatureData = { ...prev, socials: nextSocials };
      void saveSignature(next);
      return next;
    });
  };

  const removeSocialAt = (idx: number) => {
    setData((prev) => {
      const nextSocials = prev.socials.filter((_, i) => i !== idx);
      const next: SignatureData = { ...prev, socials: nextSocials };
      void saveSignature(next);
      return next;
    });
  };

  const rendered = data.kind === 'structured' ? renderSignature(data) : null;

  const importedTargets = useMemo(
    () => (data.kind === 'imported' ? detectImportedTargets(data.html) : { words: [], glyphs: [], buttons: [], images: [] }),
    [data],
  );

  const imageThumbnails = useMemo<Record<string, InlineImage>>(() => {
    const out: Record<string, InlineImage> = {};
    if (data.kind === 'imported' && data.image) {
      out['cid:zolva-sig'] = data.image;
    }
    return out;
  }, [data]);

  const socialsBlock = <SocialsSection
    socials={data.socials}
    mode={data.kind}
    targets={importedTargets}
    imageThumbnails={imageThumbnails}
    onUpdate={updateSocialAt}
    onRemove={removeSocialAt}
    onAdd={addSocial}
  />;

  return (
    <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
      <Text style={styles.sectionTitle}>Mail-signatur</Text>
      <View style={styles.inkRule} />
      <Text style={styles.signatureBody}>
        Bruges ved mails sendt fra Outlook (og iCloud, når mail-afsendelse fra Zolva er tilføjet senere).
        Gmail bruger den signatur, du allerede har sat op i Gmail-indstillingerne.
      </Text>

      <Pressable
        onPress={onImportFromScreenshot}
        disabled={importing}
        style={[styles.sigImportBtn, importing && { opacity: 0.5 }]}
        accessibilityRole="button"
      >
        <Text style={styles.sigImportBtnTitle}>
          {importing ? 'Læser signatur…' : '📷 Importér fra screenshot'}
        </Text>
        <Text style={styles.sigImportBtnSub}>
          Lad Zolva udfylde felterne fra et billede af din nuværende signatur.
        </Text>
      </Pressable>
      {importError && <Text style={styles.sigError}>{importError}</Text>}

      {data.kind === 'structured' ? (
        <>
          <SigField label="Navn"        value={data.name}        onChange={(v) => update({ name: v })}        onBlur={commit} editable={hydrated} />
          <SigField label="Titel"       value={data.title}       onChange={(v) => update({ title: v })}       onBlur={commit} editable={hydrated} />
          <SigField label="Virksomhed"  value={data.company}     onChange={(v) => update({ company: v })}     onBlur={commit} editable={hydrated} />
          <SigField label="Telefon"     value={data.phone}       onChange={(v) => update({ phone: v })}       onBlur={commit} editable={hydrated} keyboardType="phone-pad" />
          <SigField label="Email"       value={data.email}       onChange={(v) => update({ email: v })}       onBlur={commit} editable={hydrated} keyboardType="email-address" autoCapitalize="none" />
          <SigField label="Website"     value={data.website}     onChange={(v) => update({ website: v })}     onBlur={commit} editable={hydrated} autoCapitalize="none" />
          <SigField label="Egne linjer" value={data.customLines} onChange={(v) => update({ customLines: v })} onBlur={commit} editable={hydrated} multiline />
          <Text style={styles.sigInlineLinkHint}>
            Tip: lav et klikbart link med <Text style={styles.sigInlineLinkHintMono}>[tekst](url)</Text>{' '}— fx{' '}
            <Text style={styles.sigInlineLinkHintMono}>Læs vores [privatlivspolitik](zolva.io/privacy)</Text>.
          </Text>

          <Text style={styles.sigFieldLabel}>Logo</Text>
          <View style={styles.sigLogoRow}>
            {data.logo ? (
              <>
                <Image
                  source={{ uri: `data:${data.logo.mimeType};base64,${data.logo.base64}` }}
                  style={styles.sigLogoThumb}
                  resizeMode="contain"
                />
                <Pressable onPress={onRemoveLogo} style={styles.sigLogoBtn} accessibilityRole="button">
                  <Text style={styles.sigLogoBtnText}>Fjern</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                onPress={onPickLogo}
                disabled={pickerBusy}
                style={[styles.sigLogoBtn, pickerBusy && { opacity: 0.5 }]}
                accessibilityRole="button"
              >
                <Text style={styles.sigLogoBtnText}>{pickerBusy ? 'Indlæser…' : 'Vælg billede'}</Text>
              </Pressable>
            )}
          </View>
          {pickerError && <Text style={styles.sigError}>{pickerError}</Text>}

          {socialsBlock}

          <Text style={[styles.sigFieldLabel, { marginTop: 24 }]}>Forhåndsvisning</Text>
          <View style={styles.sigPreviewCard}>
            {rendered ? <SignaturePreview data={data} /> : <Text style={styles.sigPreviewEmpty}>Udfyld felterne ovenfor for at se en forhåndsvisning.</Text>}
          </View>
        </>
      ) : (
        <View style={styles.sigImportedPreviewWrap}>
          <Text style={[styles.sigFieldLabel, { marginTop: 0 }]}>Forhåndsvisning</Text>
          <View style={[styles.sigImportedPreview, { height: previewHeight }]}>
            <WebView
              key={previewKey}
              originWhitelist={['*']}
              javaScriptEnabled
              scrollEnabled={false}
              source={{ html: buildPreviewHtml(data) }}
              style={styles.sigImportedWebView}
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
            onPress={() => {
              void Haptics.selectionAsync();
              setPreviewKey((k) => k + 1);
            }}
            style={styles.sigPreviewReloadBtn}
            accessibilityRole="button"
            accessibilityLabel="Genindlæs forhåndsvisning"
          >
            <RefreshCw size={13} color={colors.fg2} strokeWidth={2.2} />
            <Text style={styles.sigPreviewReloadText}>Genindlæs forhåndsvisning</Text>
          </Pressable>
          <Text style={styles.sigImportedCardSub}>
            {`Importeret ${formatImportedDate(data.importedAt)}`}
          </Text>
          {socialsBlock}
          <Pressable onPress={onSwitchToManual} style={styles.sigSwitchBtn} accessibilityRole="button">
            <Text style={styles.sigSwitchBtnText}>Skift til manuel redigering</Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
}

function SigField(props: {
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
    <View style={{ marginTop: 14 }}>
      <Text style={styles.sigFieldLabel}>{props.label}</Text>
      <TextInput
        style={[styles.input, props.multiline && styles.signatureInput]}
        value={props.value}
        onChangeText={props.onChange}
        onBlur={props.onBlur}
        editable={props.editable}
        multiline={props.multiline}
        keyboardType={props.keyboardType ?? 'default'}
        autoCapitalize={props.autoCapitalize ?? 'sentences'}
        autoCorrect={false}
        textAlignVertical={props.multiline ? 'top' : 'center'}
      />
    </View>
  );
}

function SignaturePreview({ data }: { data: StructuredSignature }) {
  // Structural preview using RN components — not pixel-perfect against
  // every email client, but shows what fields are present.
  const headerParts = [data.name, data.title].filter(Boolean).join(' · ');
  const contactParts = [
    data.phone ? `T: ${data.phone}` : '',
    data.email,
  ].filter(Boolean).join(' · ');
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      {data.logo && (
        <Image
          source={{ uri: `data:${data.logo.mimeType};base64,${data.logo.base64}` }}
          style={{ width: 48, height: 48 }}
          resizeMode="contain"
        />
      )}
      <View style={{ flex: 1 }}>
        {!!headerParts && <Text style={{ fontWeight: '600', color: colors.ink }}>{headerParts}</Text>}
        {!!data.company && <Text style={{ color: colors.ink }}>{data.company}</Text>}
        {!!contactParts && <Text style={{ color: colors.ink }}>{contactParts}</Text>}
        {!!data.website && <Text style={{ color: colors.ink }}>{data.website}</Text>}
        {!!data.customLines.trim() && <Text style={{ color: colors.ink }}>{data.customLines}</Text>}
      </View>
    </View>
  );
}

function useNotificationPermission(): PermissionStatus {
  const [status, setStatus] = useState<PermissionStatus>('undetermined');
  useEffect(() => {
    let alive = true;
    void getPermissionStatus().then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

type SettingsScreenProps = {
  onOpenIcloudSetup?: (prefilledEmail?: string) => void;
  onOpenMicrosoftAdminConsent?: (prefilledEmail?: string) => void;
  // Bumped by App.tsx whenever the iCloud setup overlay closes, so this
  // screen reloads the credential state without remounting.
  icloudRefreshVersion?: number;
  onOpenNotifications: () => void;
  onBack: () => void;
};

export function SettingsScreen({
  onOpenIcloudSetup,
  onOpenMicrosoftAdminConsent,
  icloudRefreshVersion = 0,
  onOpenNotifications,
  onBack,
}: SettingsScreenProps) {
  const { data: user, loading: userLoading } = useUser();
  const { data: subscription } = useSubscription();
  const { data: connections, connect, disconnect } = useConnections();
  const { data: workRows, setValue: setWorkValue } = useWorkPreferences();
  const { data: toggles, flip } = usePrivacyToggles();
  const { signOut, user: authUser, googleAccessToken, microsoftAccessToken } = useAuth();
  const userId = authUser?.id ?? '';
  const [icloudCredState, setIcloudCredState] = useState<'absent' | 'valid' | 'invalid'>('absent');
  const [icloudEmail, setIcloudEmail] = useState<string | null>(null);
  const [briefSheetOpen, setBriefSheetOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setIcloudCredState('absent');
      setIcloudEmail(null);
      return;
    }
    void loadCredential(userId).then((c) => {
      if (cancelled) return;
      setIcloudCredState(c.kind);
      setIcloudEmail(c.kind !== 'absent' ? c.credential.email : null);
    });
    return () => { cancelled = true; };
  }, [userId, icloudRefreshVersion]);

  const icloudConnection: Connection = {
    id: 'icloud',
    title: 'iCloud',
    sub:
      icloudCredState === 'valid'   ? (icloudEmail ?? 'Mail og kalender')
    : icloudCredState === 'invalid' ? 'Adgangskoden er afvist'
                                    : 'Mail og kalender',
    status:
      icloudCredState === 'valid'   ? 'connected'
    : icloudCredState === 'invalid' ? 'expired'
                                    : 'disconnected',
    logo: 'icloud.png', // never read — row renderer special-cases iCloud to use the lucide Cloud icon (Apple trademark constraint).
  };
  const allConnections: Connection[] = [icloudConnection, ...connections];

  const hasGoogleOrMicrosoft = !!(googleAccessToken || microsoftAccessToken);
  const hasIcloud = icloudCredState === 'valid';
  const briefVariant: 'normal' | 'icloud-only' =
    !hasGoogleOrMicrosoft && hasIcloud ? 'icloud-only' : 'normal';
  const briefProviderSub = hasGoogleOrMicrosoft
    ? `Bruger din ${googleAccessToken ? 'Gmail' : 'Outlook'} konto`
    : undefined;

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const notificationSettings = useNotificationSettings();
  const permission = useNotificationPermission();

  const openPrivacyPolicy = async () => {
    const url = getPrivacyPolicyUrl();
    if (!url) {
      Alert.alert(
        'Privatlivspolitik',
        'Privatlivspolitikken er ikke publiceret endnu. Skriv til Kontakt@zolva.io for at få en kopi.',
      );
      return;
    }
    try {
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
    } catch (err) {
      if (__DEV__) console.warn('[settings] privacy policy open failed:', err);
    }
  };

  const toggleNotificationSetting = async (key: keyof NotificationSettings, next: boolean) => {
    if (next) {
      const result = await ensurePermission();
      if (result !== 'granted') {
        Alert.alert(
          'Tillad notifikationer',
          'Zolva kan ikke sende notifikationer før du giver tilladelse i systemindstillingerne.',
          [
            { text: 'Ikke nu', style: 'cancel' },
            { text: 'Åbn indstillinger', onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }
    }

    if (key === 'newMail') {
      if (next) {
        const registration = await registerPushToken();
        if (!registration.ok && registration.reason === 'no-session') {
          Alert.alert('Nye mails', 'Log ind før du aktiverer mail-notifikationer.');
          return;
        }
        if (!registration.ok && !__DEV__) {
          Alert.alert('Nye mails', 'Kunne ikke registrere enheden. Prøv igen om lidt.');
          return;
        }
        // In dev (or when the push token registration soft-failed) we still
        // flip the server-side watcher on so polling runs end-to-end. Push
        // delivery simply no-ops until a real device registers a token.
        await setMailWatchersEnabled(true);
      } else {
        await unregisterPushToken();
        await setMailWatchersEnabled(false);
      }
    }

    await setNotificationSetting(key, next);
    void syncOnAppForeground();
  };

  const handleConnect = async (id: typeof connections[number]['id']) => {
    if (connectingId) return;
    setConnectingId(id);
    const result = await connect(id);
    setConnectingId(null);

    // Detected admin-consent: open the screen with whatever tenant hint we have.
    if (result.adminConsent && onOpenMicrosoftAdminConsent) {
      const hint = result.adminConsent.tenantHint
        ?? (authUser?.email ? authUser.email : undefined);
      onOpenMicrosoftAdminConsent(hint);
      return;
    }

    if (result.error) {
      if (__DEV__) console.warn('[auth] connect provider failed:', id, result.error);
      Alert.alert('Kunne ikke forbinde', translateProviderError(result.error).message);
      return;
    }

    // Cancel-path heuristic for Microsoft: most enterprise tenants render the
    // admin-consent block on Microsoft's own page, and users close the browser
    // rather than letting it redirect. Ask once whether that's what they saw.
    const isMicrosoft = id === 'outlook-mail' || id === 'outlook-calendar';
    if (result.cancelled && isMicrosoft && onOpenMicrosoftAdminConsent) {
      Alert.alert(
        'Krævede din administrator godkendelse?',
        'Hvis Microsoft viste en besked om at en administrator skal godkende Zolva, kan vi hjælpe dig med at sende en anmodning.',
        [
          { text: 'Nej, prøv igen', style: 'cancel' },
          {
            text: 'Ja, send anmodning',
            onPress: () => onOpenMicrosoftAdminConsent(authUser?.email ?? undefined),
          },
        ],
      );
    }
  };

  // Per-provider disconnect. A single OAuth grant covers all Google (Gmail +
  // Calendar + Drive) or all Microsoft (Outlook Mail + Calendar), so the
  // confirmation copy tells the user which services they're giving up.
  const disconnectCopy = (id: typeof connections[number]['id']): { title: string; message: string } => {
    const isGoogle = id === 'google-calendar' || id === 'gmail' || id === 'google-drive';
    if (isGoogle) {
      return {
        title: 'Frakobl Google',
        message: 'Zolva mister adgang til Gmail, Google Kalender og Google Drive. Du kan forbinde igen når som helst.',
      };
    }
    return {
      title: 'Frakobl Microsoft',
      message: 'Zolva mister adgang til Outlook Mail og Kalender. Du kan forbinde igen når som helst.',
    };
  };

  const confirmIcloudDisconnect = () => {
    Alert.alert(
      'Frakobl iCloud?',
      'Mails og kalenderbegivenheder fra iCloud forsvinder fra Zolva.',
      [
        { text: 'Annullér', style: 'cancel' },
        {
          text: 'Frakobl', style: 'destructive',
          onPress: async () => {
            if (!userId) return;
            await clearCredential(userId);
            await clearDiscoveryCacheFor(userId);
            // Best-effort: wipe the server-side binding row so the user can
            // reconnect with a freshly-rotated app-specific password without
            // hitting the bound-hash mismatch (auth-failed). Failure is
            // non-blocking — the cron sweep is the eventual fallback.
            const r = await clearIcloudBinding();
            if (!r.ok && __DEV__) {
              console.warn('[settings] icloud clear-binding failed:', r.error);
            }
            setIcloudCredState('absent');
            setIcloudEmail(null);
          },
        },
      ],
    );
  };

  const handleDisconnect = (id: typeof connections[number]['id']) => {
    if (connectingId) return;
    const { title, message } = disconnectCopy(id);
    Alert.alert(title, message, [
      { text: 'Annullér', style: 'cancel' },
      {
        text: 'Frakobl',
        style: 'destructive',
        onPress: async () => {
          setConnectingId(id);
          const { error } = await disconnect(id);
          setConnectingId(null);
          if (error) {
            if (__DEV__) console.warn('[auth] disconnect provider failed:', id, error);
            Alert.alert('Kunne ikke frakoble', translateProviderError(error).message);
          }
        },
      },
    ]);
  };

  const isLoggedIn = !!user;
  const { bottom: chromeBottom } = useChromeInsets();

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: chromeBottom }]}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <View style={styles.heroTopRow}>
            <Pressable
              onPress={onBack}
              style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Tilbage"
            >
              <ChevronLeft size={20} color={colors.ink} strokeWidth={1.75} />
            </Pressable>
            <TopRightActions onOpenNotifications={onOpenNotifications} />
          </View>
          <Text style={styles.eyebrow}>
            {user ? `Konto · ${user.email}` : 'Konto'}
          </Text>
          <Text style={styles.heroH1}>Indstillinger</Text>
        </View>

        {userLoading ? (
          <View style={styles.authLoading}>
            <ActivityIndicator color={colors.sageDeep} />
          </View>
        ) : !isLoggedIn ? (
          <LoginCard />
        ) : (
          <>
            <View style={styles.speech}>
              <Stone mood="calm" size={40} />
              <View style={{ flex: 1 }}>
                <Text style={styles.speechText}>
                  Jeg arbejder sådan her. Skru på det du vil - resten passer jeg.
                </Text>
              </View>
            </View>

            <CollapsibleSection title="Sådan arbejder jeg">
              {workRows.map((r) =>
                r.id === 'morning-brief' && briefVariant === 'icloud-only' ? (
                  <View key={r.id} style={styles.disabledPrefRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.workTitle}>{r.title}</Text>
                      <Text style={styles.workMeta}>Kræver Gmail eller Outlook for nu</Text>
                    </View>
                    <Pressable onPress={() => setBriefSheetOpen(true)} hitSlop={8} accessibilityRole="button">
                      <Text style={styles.linkText}>Læs mere</Text>
                    </Pressable>
                  </View>
                ) : (
                  <WorkPreferenceRow
                    key={r.id}
                    pref={r}
                    sub={r.id === 'morning-brief' ? briefProviderSub : undefined}
                    onChange={async (v) => {
                      const result = await setWorkValue(r.id, v);
                      if (result.ok) return;
                      const message =
                        result.reason === 'unauthenticated' || result.reason === 'rls'
                          ? 'Kunne ikke gemme — log ind igen.'
                          : 'Kunne ikke gemme. Prøv igen om lidt.';
                      Alert.alert('Indstillinger', message);
                    }}
                  />
                ),
              )}
            </CollapsibleSection>

            <CollapsibleSection title="Forbundet" paddingTop={28}>
              {allConnections.map((c, i) => {
                const pillStyle =
                  c.status === 'connected' ? styles.statusSage :
                    c.status === 'pending' ? styles.statusWarn :
                      c.status === 'expired' ? styles.statusWarn :
                        styles.statusNeutral;
                const textStyle =
                  c.status === 'connected' ? styles.statusTextSage :
                    c.status === 'pending' ? styles.statusTextWarn :
                      c.status === 'expired' ? styles.statusTextWarn :
                        styles.statusTextNeutral;
                const isConnected = c.status === 'connected';
                // iCloud's expired state is tappable (re-enter flow). Other
                // providers' 'expired' remains non-interactive — no UI yet.
                const tappable =
                  isConnected ||
                  c.status === 'disconnected' ||
                  (c.id === 'icloud' && c.status === 'expired');
                const isBusy = connectingId === c.id;
                const onRowPress =
                  c.id === 'icloud'
                    ? (isConnected
                        ? () => confirmIcloudDisconnect()
                        : () => onOpenIcloudSetup?.(icloudEmail ?? undefined))
                    : (isConnected
                        ? () => handleDisconnect(c.id)
                        : () => handleConnect(c.id));
                return (
                  <Pressable
                    key={c.id}
                    onPress={tappable ? onRowPress : undefined}
                    disabled={!tappable || isBusy}
                    style={({ pressed }) => [
                      styles.connRow,
                      i > 0 && styles.connBorder,
                      tappable && pressed && styles.connRowPressed,
                    ]}
                  >
                    <View style={styles.logoBox}>
                      <Image
                        source={LOGOS[c.logo]}
                        style={[styles.logo, c.logo === 'gmail.png' && { transform: [{ scale: 1.35 }] }]}
                        resizeMode="contain"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.connTitle}>{c.title}</Text>
                      <Text style={styles.connSub}>{c.sub}</Text>
                    </View>
                    {isBusy ? (
                      <ActivityIndicator color={colors.sageDeep} />
                    ) : c.status === 'disconnected' ? (
                      <View style={styles.connectPill}>
                        <Text style={styles.connectPillText}>Forbind →</Text>
                      </View>
                    ) : (
                      <View style={[styles.statusPill, pillStyle]}>
                        <Text style={[styles.statusText, textStyle]}>{STATUS_LABEL[c.status]}</Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
              {COMING_SOON_INTEGRATIONS.map((c) => (
                <View key={c.key} style={[styles.connRow, styles.connBorder, styles.connRowComingSoon]}>
                  <View style={styles.logoBox}>
                    <Image source={LOGOS[c.logo]} style={styles.logo} resizeMode="contain" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.connTitle}>{c.title}</Text>
                    <Text style={styles.connSub}>{c.sub}</Text>
                  </View>
                  <View style={[styles.statusPill, styles.statusNeutral]}>
                    <Text style={[styles.statusText, styles.statusTextNeutral]}>Kommer snart</Text>
                  </View>
                </View>
              ))}
            </CollapsibleSection>

            <StemmestyringSection hasIcloud={hasIcloud} />

            <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
              <Text style={styles.sectionTitle}>Abonnement</Text>
              <View style={styles.inkRule} />
              {subscription ? (
                <View style={styles.planRow}>
                  <Text style={styles.planPrice}>
                    {subscription.priceKr}
                    <Text style={styles.planUnit}> kr/md</Text>
                  </Text>
                  <Text style={styles.planMeta}>{`${subscription.plan} · fornyes ${subscription.renewalDate}`}</Text>
                </View>
              ) : (
                <Text style={styles.emptyText}>Ingen aktiv plan.</Text>
              )}
              <View style={styles.planButtons}>
                <Pressable
                  style={styles.btnInk}
                  onPress={() =>
                    Alert.alert(
                      subscription ? 'Skift plan' : 'Vælg plan',
                      'Abonnementshåndtering er på vej. Kontakt os på Kontakt@zolva.io for at ændre din plan.',
                    )
                  }
                >
                  <Text style={styles.btnInkText}>{subscription ? 'Skift plan' : 'Vælg plan'}</Text>
                </Pressable>
              </View>
            </Animated.View>

            <Animated.View layout={ROW_TRANSITION} style={styles.dark}>
              <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
                <Stone mood="thinking" size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.darkTitle}>Privatliv</Text>
                  {/* Copy fact-checked 2026-04-20:
                     - Anthropic retention: workspace does NOT have ZDR, so default
                       up to 30 days T&S retention applies. State that plainly.
                     - Supabase region: eu-west-1 (Ireland) — EU. */}
                  <Text style={styles.darkBody}>
                    Indholdet af dine mails og kalender sendes til Anthropic (Claude) for at lave
                    opsummeringer og udkast. Anthropic kan opbevare data i op til 30 dage til
                    misbrugsovervågning. Dine mails bruges{' '}
                    <Text style={styles.darkStrong}>ikke</Text> til at træne modeller. Konti og
                    tokens hostes i EU hos Supabase.
                  </Text>
                  <View style={{ marginTop: 16, gap: 10 }}>
                    {toggles.map((t) => (
                      <ToggleRow key={t.id} label={t.label} on={t.enabled} onPress={() => flip(t.id)} />
                    ))}
                  </View>
                  {/* Export button removed: a fake Alert is a GDPR liability. Rewire to a real
                      Edge Function (JSON bundle + Resend email) before bringing this back.

                      T3 handoff — please add to legal/privacy-policy-da.md AND
                      legal/privacy-policy-en.md:

                        DA: "For at anmode om en kopi af dine data, skriv til
                             <contact email>. Vi svarer inden for 30 dage jf.
                             GDPR art. 15."
                        EN: "To request a copy of your data, email <contact
                             email>. We respond within 30 days per GDPR Art. 15."

                      Do NOT surface the email in app UI — it belongs in the
                      privacy policy so it stays one authoritative source. */}
                </View>
              </View>
            </Animated.View>

            <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
              <Text style={styles.sectionTitle}>Notifikationer</Text>
              <View style={styles.inkRule} />
              {permission === 'denied' ? (
                <Pressable style={styles.permissionBanner} onPress={() => Linking.openSettings()}>
                  <Text style={styles.permissionBannerText}>
                    Notifikationer er slået fra i systemindstillingerne. Tryk for at åbne.
                  </Text>
                </Pressable>
              ) : null}
              <NotificationToggleRow
                label="Påmindelser"
                value={notificationSettings.reminders}
                onChange={(v) => toggleNotificationSetting('reminders', v)}
              />
              <NotificationToggleRow
                label="Morgenoverblik"
                value={notificationSettings.digest}
                onChange={(v) => toggleNotificationSetting('digest', v)}
              />
              <NotificationToggleRow
                label="Kalender-påmindelse 15 min før"
                value={notificationSettings.preAlerts}
                onChange={(v) => toggleNotificationSetting('preAlerts', v)}
              />
              <NotificationToggleRow
                label="Nye mails"
                value={notificationSettings.newMail}
                onChange={(v) => toggleNotificationSetting('newMail', v)}
              />
            </Animated.View>

            <MailSignatureSection />

            {/* T4: the privacy copy + export-button live above in the dark
                "Privatliv" card. This Konto section is the account-deletion
                entry point; please don't move privacy/export into here. */}
            <Animated.View layout={ROW_TRANSITION} style={[styles.section, { paddingTop: 28 }]}>
              <Text style={styles.sectionTitle}>Konto</Text>
              <View style={styles.inkRule} />
              <Pressable
                style={({ pressed }) => [styles.accountRow, pressed && styles.accountRowPressed]}
                onPress={openPrivacyPolicy}
                accessibilityRole="link"
              >
                <Text style={styles.accountRowLabel}>Privatlivspolitik</Text>
                <Text style={styles.accountRowChevron}>→</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.accountRow,
                  styles.accountRowBorder,
                  pressed && styles.accountRowPressed,
                ]}
                onPress={() => setDeleteOpen(true)}
                accessibilityRole="button"
              >
                <Text style={[styles.accountRowLabel, styles.accountRowDestructive]}>
                  Slet konto
                </Text>
                <Text style={[styles.accountRowChevron, styles.accountRowDestructive]}>→</Text>
              </Pressable>
            </Animated.View>

            {user?.email === 'albertfeldt1@gmail.com' && (
              <Pressable
                onPress={async () => {
                  const { data } = await supabase.auth.getSession();
                  const token = data.session?.access_token;
                  if (!token) {
                    Alert.alert('Ikke logget ind', 'Log ind først.');
                    return;
                  }
                  await Clipboard.setStringAsync(token);
                  const minutesLeft = data.session?.expires_at
                    ? Math.round((data.session.expires_at * 1000 - Date.now()) / 60000)
                    : 0;
                  Alert.alert('JWT kopieret', `Udløber om ${minutesLeft} min`);
                }}
                style={{ padding: 16, backgroundColor: '#333', borderRadius: 8, marginTop: 24 }}
              >
                <Text style={{ color: '#fff' }}>Copy JWT (dev)</Text>
              </Pressable>
            )}

            <AnimatedPressable
              layout={ROW_TRANSITION}
              style={styles.signOutRow}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                Alert.alert(
                  'Log ud',
                  'Er du sikker på, at du vil logge ud?',
                  [
                    { text: 'Annullér', style: 'cancel' },
                    {
                      text: 'Log ud',
                      style: 'destructive',
                      onPress: () => {
                        void signOut();
                      },
                    },
                  ],
                );
              }}
            >
              <Text style={styles.signOutText}>Log ud</Text>
            </AnimatedPressable>
          </>
        )}
      </ScrollView>

      <Modal
        visible={deleteOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setDeleteOpen(false)}
      >
        <DeleteAccountScreen
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => setDeleteOpen(false)}
        />
      </Modal>

      <IcloudBriefSheet
        visible={briefSheetOpen}
        onClose={() => setBriefSheetOpen(false)}
        onConnectGmail={() => handleConnect('gmail')}
      />
    </KeyboardAvoidingView>
  );
}

function StemmestyringSection({ hasIcloud }: { hasIcloud: boolean }) {
  const { user, googleAccessToken, microsoftAccessToken } = useAuth();
  const { labels, setLabel } = useCalendarLabels();
  const [picker, setPicker] = useState<CalendarLabelKey | null>(null);
  const [calendars, setCalendars] = useState<ProviderCalendar[]>([]);
  const [loadingCalendars, setLoadingCalendars] = useState(false);

  const hasAnyProvider = !!googleAccessToken || !!microsoftAccessToken || hasIcloud;

  const openPicker = async (key: CalendarLabelKey) => {
    if (!user?.id) return;
    setPicker(key);
    setLoadingCalendars(true);
    try {
      const list = await listWritableCalendars({
        hasGoogle: !!googleAccessToken,
        hasMicrosoft: !!microsoftAccessToken,
        hasIcloud,
        userId: user.id,
      });
      setCalendars(list);
    } finally {
      setLoadingCalendars(false);
    }
  };

  const providerFallbackName = (provider: 'google' | 'microsoft' | 'icloud'): string => {
    if (provider === 'google')    return 'Google kalender';
    if (provider === 'microsoft') return 'Microsoft kalender';
    return 'iCloud kalender';
  };

  const labelRow = (key: CalendarLabelKey, label: string) => {
    const target = labels[key];
    const display = target
      ? calendars.find((c) => c.provider === target.provider && c.id === target.id)?.name
        ?? providerFallbackName(target.provider)
      : 'Ikke valgt';
    return (
      <Pressable onPress={() => openPicker(key)} style={styles.row}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{display} ›</Text>
      </Pressable>
    );
  };

  if (!hasAnyProvider) {
    return (
      <CollapsibleSection title="Stemmestyring" paddingTop={28}>
        <Text style={styles.sectionBody}>
          Forbind Google, Outlook eller iCloud for at sætte møder med Siri.
        </Text>
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection title="Stemmestyring (Voice)" paddingTop={28}>
      <Text style={styles.sectionBody}>
        Når du beder Siri "bed Zolva om at sætte et møde", lander mødet i den
        kalender du vælger her. Sig "i min arbejdskalender" for at tilsidesætte.
      </Text>
      {labelRow('work', 'Arbejdskalender (Work)')}
      {labelRow('personal', 'Privatkalender (Personal)')}

      <Modal
        visible={picker !== null}
        animationType="slide"
        onRequestClose={() => setPicker(null)}
      >
        <SafeAreaView style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              {picker === 'work' ? 'Vælg arbejdskalender' : 'Vælg privatkalender'}
            </Text>
            <Pressable onPress={() => setPicker(null)}>
              <Text style={styles.modalCancel}>Annullér</Text>
            </Pressable>
          </View>
          {loadingCalendars ? (
            <ActivityIndicator style={{ marginTop: 24 }} color={colors.sageDeep} />
          ) : (
            <ScrollView contentContainerStyle={{ padding: 16 }}>
              <Pressable
                style={styles.pickerRow}
                onPress={async () => {
                  if (picker) await setLabel(picker, null);
                  setPicker(null);
                }}
              >
                <Text style={styles.pickerRowText}>○ Brug ikke</Text>
              </Pressable>
              {groupByAccount(calendars).map((section) => (
                <View key={section.heading} style={{ marginTop: 16 }}>
                  <Text style={styles.pickerHeading}>{section.heading}</Text>
                  {section.items.map((c) => {
                    const selected =
                      picker !== null &&
                      labels[picker]?.provider === c.provider &&
                      labels[picker]?.id === c.id;
                    return (
                      <Pressable
                        key={`${c.provider}:${c.id}`}
                        style={styles.pickerRow}
                        onPress={async () => {
                          if (picker) {
                            await setLabel(picker, { provider: c.provider, id: c.id });
                          }
                          setPicker(null);
                        }}
                      >
                        <Text style={styles.pickerRowText}>
                          {selected ? '● ' : '○ '}
                          {c.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </CollapsibleSection>
  );
}

function groupByAccount(calendars: ProviderCalendar[]) {
  const groups = new Map<string, ProviderCalendar[]>();
  for (const c of calendars) {
    const headingProvider =
      c.provider === 'google'    ? 'GOOGLE' :
      c.provider === 'microsoft' ? 'MICROSOFT' :
                                   'ICLOUD';
    const heading = `${headingProvider} — ${c.accountEmail ?? 'Ukendt konto'}`;
    if (!groups.has(heading)) groups.set(heading, []);
    groups.get(heading)!.push(c);
  }
  return Array.from(groups.entries()).map(([heading, items]) => ({ heading, items }));
}

function LoginCard() {
  const { signIn, signUp, signInWithGoogle, signInWithApple, appleAvailable } = useAuth();
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<null | 'google' | 'apple'>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async () => {
    if (busy || oauthBusy) return;
    setError(null);
    setInfo(null);
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setError('Udfyld mail og kodeord.');
      return;
    }
    setBusy(true);
    const fn = mode === 'sign-in' ? signIn : signUp;
    const { data, error: err } = await fn(trimmed, password);
    setBusy(false);
    if (err) {
      if (__DEV__) console.warn('[auth] email sign-in failed:', err);
      setError(translateProviderError(err).message);
      return;
    }
    if (mode === 'sign-up' && !data.session) {
      // Supabase returns a fake user with empty identities when the email
      // is already registered (enumeration protection). Detect that and
      // nudge the user toward sign-in instead of telling them to check a
      // mail that will never arrive.
      const identities = data.user?.identities;
      if (Array.isArray(identities) && identities.length === 0) {
        setError('Der findes allerede en konto med den mail. Log ind i stedet.');
        return;
      }
      setInfo('Tjek din mail for at bekræfte din konto.');
    }
  };

  const oauth = async (provider: 'google' | 'apple') => {
    if (busy || oauthBusy) return;
    setError(null);
    setInfo(null);
    setOauthBusy(provider);
    try {
      const { error: err } =
        provider === 'google' ? await signInWithGoogle() : await signInWithApple();
      if (err) {
        if (__DEV__) console.warn(`[auth] ${provider} sign-in returned error:`, err);
        setError(translateProviderError(err).message);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Apple's user-cancel throws ERR_REQUEST_CANCELED — silent ignore
      if (!raw.includes('CANCELED') && !raw.includes('canceled')) {
        if (__DEV__) console.warn(`[auth] ${provider} sign-in threw:`, e);
        setError(translateProviderError(e).message);
      }
    } finally {
      setOauthBusy(null);
    }
  };

  const anyBusy = busy || !!oauthBusy;

  return (
    <View style={styles.loginWrap}>
      <Text style={styles.loginTitle}>
        {mode === 'sign-in' ? 'Log ind' : 'Opret konto'}
      </Text>
      <Text style={styles.loginBody}>
        Forbind dine konti og lad Zolva hjælpe dig med dagen.
      </Text>

      <Pressable
        style={[styles.socialBtn, anyBusy && styles.loginPrimaryBusy]}
        onPress={() => oauth('google')}
        disabled={anyBusy}
      >
        {oauthBusy === 'google' ? (
          <ActivityIndicator color={colors.ink} />
        ) : (
          <>
            <GoogleGlyph />
            <Text style={styles.socialText}>Fortsæt med Google</Text>
          </>
        )}
      </Pressable>

      {appleAvailable && (
        <Pressable
          style={[styles.socialBtnDark, anyBusy && styles.loginPrimaryBusy]}
          onPress={() => oauth('apple')}
          disabled={anyBusy}
        >
          {oauthBusy === 'apple' ? (
            <ActivityIndicator color={colors.paper} />
          ) : (
            <>
              <AppleGlyph />
              <Text style={styles.socialTextDark}>Fortsæt med Apple</Text>
            </>
          )}
        </Pressable>
      )}

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>eller med email</Text>
        <View style={styles.dividerLine} />
      </View>

      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="email@eksempel.dk"
        placeholderTextColor={colors.fg3}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        editable={!anyBusy}
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="Kodeord"
        placeholderTextColor={colors.fg3}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="password"
        editable={!anyBusy}
        onSubmitEditing={submit}
        returnKeyType="go"
      />

      {error && <Text style={styles.loginError}>{error}</Text>}
      {info && <Text style={styles.loginInfo}>{info}</Text>}

      <Pressable
        style={[styles.loginPrimary, anyBusy && styles.loginPrimaryBusy]}
        onPress={submit}
        disabled={anyBusy}
      >
        {busy ? (
          <ActivityIndicator color={colors.paper} />
        ) : (
          <Text style={styles.loginPrimaryText}>
            {mode === 'sign-in' ? 'Log ind' : 'Opret konto'}
          </Text>
        )}
      </Pressable>

      <Pressable
        style={styles.loginToggle}
        onPress={() => {
          setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
          setError(null);
          setInfo(null);
        }}
        disabled={anyBusy}
      >
        <Text style={styles.loginToggleText}>
          {mode === 'sign-in'
            ? 'Har du ikke en konto? Opret en →'
            : 'Har du allerede en konto? Log ind →'}
        </Text>
      </Pressable>

      {__DEV__ && (
        <Text style={styles.debugHint} selectable>
          OAuth redirect: {makeRedirectUri({ scheme: 'zolva', path: 'auth/callback' })}
        </Text>
      )}
    </View>
  );
}

function GoogleGlyph() {
  return (
    <Image
      source={require('../../assets/logos/google.png')}
      style={styles.googleGlyph}
      resizeMode="contain"
    />
  );
}

function AppleGlyph() {
  return (
    <Image
      source={require('../../assets/logos/apple.png')}
      style={styles.appleGlyph}
      resizeMode="contain"
    />
  );
}

function WorkPreferenceRow({
  pref,
  sub,
  onChange,
}: {
  pref: WorkPreference;
  sub?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  const pick = (value: string) => {
    onChange(value);
    setOpen(false);
  };
  const shown = pref.value ?? 'Sæt op';

  return (
    <Animated.View layout={ROW_TRANSITION} style={styles.workRow}>
      <Pressable
        onPress={toggle}
        style={({ pressed }) => [styles.workHeader, pressed && styles.workHeaderPressed]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.workTitle}>{pref.title}</Text>
          <Text style={styles.workMeta}>{sub ?? pref.meta}</Text>
        </View>
        <Text style={styles.workVal}>
          {shown} {open ? '↑' : '↓'}
        </Text>
      </Pressable>
      {open && (
        <Animated.View
          entering={OPTIONS_ENTER}
          exiting={OPTIONS_EXIT}
          style={styles.workOptions}
        >
          {pref.options.map((opt) => {
            const selected = pref.value === opt;
            return (
              <Pressable
                key={opt}
                onPress={() => pick(opt)}
                style={({ pressed }) => [
                  styles.workOption,
                  selected && styles.workOptionOn,
                  pressed && styles.workOptionPressed,
                ]}
              >
                {selected && (
                  <Check size={13} color={colors.sageDeep} strokeWidth={2.4} />
                )}
                <Text style={[styles.workOptionText, selected && styles.workOptionTextOn]}>
                  {opt}
                </Text>
              </Pressable>
            );
          })}
        </Animated.View>
      )}
    </Animated.View>
  );
}

function ToggleRow({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <LiquidToggle
        value={on}
        onChange={onPress}
        width={38}
        height={22}
        padding={2}
        // On-tint: vivid sage at high opacity. Lower opacity through the
        // glass blur read as olive/grey; this stays readable as green.
        tintOff="rgba(246,241,232,0.18)"
        tintOn="rgba(115,170,95,0.92)"
      />
    </View>
  );
}

function NotificationToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Pressable
      style={styles.ntRow}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
    >
      <Text style={styles.ntLabel}>{label}</Text>
      <LiquidToggle
        value={value}
        onChange={onChange}
        width={46}
        height={28}
        padding={3}
        tintOff="rgba(140,133,120,0.20)"
        tintOn="rgba(115,170,95,0.92)"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, backgroundColor: colors.paper },

  hero: {
    backgroundColor: colors.sageSoft,
    paddingTop: 56,
    paddingBottom: 22,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: {
    fontFamily: fonts.mono, fontSize: 11,
    letterSpacing: 0.88, textTransform: 'uppercase', color: colors.sageDeep,
  },
  heroH1: {
    marginTop: 10,
    fontFamily: fonts.displayItalic,
    fontSize: 36, lineHeight: 40,
    letterSpacing: -1.08, color: colors.ink,
  },

  authLoading: { paddingVertical: 60, alignItems: 'center' },

  loginWrap: {
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 32,
    gap: 10,
  },
  loginTitle: {
    fontFamily: fonts.displayItalic,
    fontSize: 28,
    letterSpacing: -0.84,
    color: colors.ink,
  },
  loginBody: {
    fontFamily: fonts.ui,
    fontSize: 14,
    lineHeight: 20,
    color: colors.fg3,
    marginBottom: 8,
  },
  input: {
    backgroundColor: colors.mist,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontFamily: fonts.ui,
    fontSize: 15,
    color: colors.ink,
  },
  signatureInput: {
    minHeight: 96,
    paddingTop: 14,
    marginTop: 12,
  },
  sigFieldLabel: {
    marginTop: 8,
    marginBottom: 4,
    fontSize: 13,
    color: colors.fg3,
    fontWeight: '500',
  },
  sigInlineLinkHint: {
    marginTop: 6,
    fontSize: 12,
    color: colors.fg3,
    lineHeight: 16,
  },
  sigInlineLinkHintMono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 11,
    color: colors.fg2,
  },
  sigLogoRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  sigLogoThumb: {
    width: 56,
    height: 56,
    backgroundColor: colors.mist,
    borderRadius: 8,
  },
  sigLogoBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.ink,
  },
  sigLogoBtnText: {
    color: colors.paper,
    fontWeight: '500',
  },
  sigImportBtn: {
    marginTop: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.mist,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  sigImportBtnTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },
  sigImportBtnSub: {
    marginTop: 4,
    fontSize: 12,
    color: colors.fg3,
  },
  sigError: {
    marginTop: 8,
    color: colors.warningInk,
    fontSize: 13,
  },
  sigPreviewCard: {
    marginTop: 8,
    padding: 16,
    borderRadius: 12,
    backgroundColor: colors.mist,
    minHeight: 80,
  },
  sigPreviewEmpty: {
    color: colors.fg3,
    fontStyle: 'italic',
  },
  sigImportedPreviewWrap: {
    marginTop: 16,
  },
  sigImportedPreview: {
    // Dynamic height — see the inline style override on the preview View
    // and the WebView's injectedJavaScript / onMessage that measure
    // document.body.scrollHeight and update previewHeight state.
    minHeight: 80,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: '#fff',
    marginTop: 8,
  },
  sigImportedWebView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  sigImportedCardSub: {
    marginTop: 8,
    fontSize: 12,
    color: colors.fg3,
  },
  sigPreviewReloadBtn: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignSelf: 'flex-start',
  },
  sigPreviewReloadText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.fg2,
    letterSpacing: -0.1,
  },
  sigSwitchBtn: {
    marginTop: 14,
    padding: 12,
    borderRadius: 12,
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    alignItems: 'center',
  },
  sigSwitchBtnText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.ink,
  },
  sigSocialsWrap: {
    marginTop: 16,
  },
  sigSocialsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sigSocialsCountPill: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sigSocialsCountText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
    includeFontPadding: false,
  },
  sigSocialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
  },
  sigSocialBrandBtn: {
    // The BrandIcon already provides its own background; keep this wrapper
    // transparent so the press-feedback scale is clean.
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sigSocialInputs: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  sigSocialUrlInput: {
    flex: 1,
    minWidth: 140,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: '#fff',
    fontSize: 13,
    color: colors.ink,
  },
  sigSocialLabelInput: {
    width: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: '#fff',
    fontSize: 13,
    color: colors.ink,
  },
  sigSocialRemoveBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.mist,
  },
  sigSocialAddBtn: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.mist,
  },
  sigSocialAddBtnEmpty: {
    borderStyle: 'dashed',
    backgroundColor: 'transparent',
  },
  sigSocialAddPlus: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  sigSocialAddBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
    letterSpacing: -0.1,
  },
  sigWheelStage: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sigWheelOrigin: {
    width: 0,
    height: 0,
  },
  sigWheelSeed: {
    position: 'absolute',
    left: -22,
    top: -22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  sigWheelPetal: {
    position: 'absolute',
    left: -39,  // -WHEEL_PETAL_BOX/2
    top: -39,
    width: 78,
    height: 78,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  sigWheelPetalIconRing: {
    padding: 2,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  sigWheelPetalIconRingSelected: {
    padding: 2,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: '#ffffff',
    shadowColor: '#fff',
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  sigWheelPetalLabel: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  sigBindPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: 'flex-start',
  },
  sigBindPillUnbound: {
    backgroundColor: colors.mist,
    borderColor: colors.line,
  },
  sigBindPillBound: {
    backgroundColor: 'rgba(58, 122, 254, 0.1)',
    borderColor: 'rgba(58, 122, 254, 0.4)',
  },
  sigBindPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink,
    letterSpacing: -0.1,
  },
  sigBindFloatWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  sigBindFloat: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.paper,
    borderRadius: 22,
    paddingTop: 18,
    paddingHorizontal: 18,
    paddingBottom: 18,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  sigBindSheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.3,
    marginBottom: 12,
  },
  sigBindSheetSub: {
    fontSize: 12,
    color: colors.fg3,
    lineHeight: 16,
    marginBottom: 16,
  },
  sigBindSectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.fg3,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 14,
    marginBottom: 10,
  },
  sigBindUnbindPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#f4f4f5',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  sigBindUnbindPillSelected: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  sigBindUnbindPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.fg2,
    letterSpacing: -0.1,
  },
  sigBindUnbindPillTextSelected: {
    color: '#fff',
  },
  sigBindWordWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sigBindButtonsCol: {
    flexDirection: 'column',
    gap: 8,
  },
  sigBindButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 12,
    backgroundColor: '#f4f4f5',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.05)',
  },
  sigBindButtonRowSelected: {
    backgroundColor: '#eef0f3',
    borderColor: colors.ink,
  },
  sigBindButtonChip: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sigBindButtonChipText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.1,
  },
  sigBindWordChip: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: '#f4f4f5',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.05)',
    maxWidth: 220,
  },
  sigBindWordChipSelected: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  sigBindWordChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
    letterSpacing: -0.1,
  },
  sigBindWordChipTextSelected: {
    color: '#fff',
  },
  sigBindImageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: '#f4f4f5',
    marginBottom: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.05)',
  },
  sigBindImageRowSelected: {
    backgroundColor: '#eef0f3',
    borderColor: colors.ink,
  },
  sigBindImageThumb: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.06)',
  },
  sigBindImageThumbImg: {
    width: '100%',
    height: '100%',
  },
  sigBindImageDesc: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: colors.ink,
  },
  sigBindEmptyState: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingHorizontal: 12,
  },
  sigBindEmptyEmoji: {
    fontSize: 28,
    marginBottom: 8,
  },
  sigBindEmptyTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
    marginBottom: 4,
  },
  sigBindEmptyHint: {
    fontSize: 12,
    color: colors.fg3,
    lineHeight: 16,
    textAlign: 'center',
  },
  signatureBody: {
    fontFamily: fonts.ui,
    fontSize: 13,
    lineHeight: 18,
    color: colors.fg3,
    marginTop: 12,
  },
  loginError: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.warningInk,
  },
  loginInfo: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.sageDeep,
  },
  loginPrimary: {
    marginTop: 6,
    backgroundColor: colors.ink,
    paddingVertical: 14,
    borderRadius: 999,
    alignItems: 'center',
  },
  loginPrimaryBusy: { opacity: 0.7 },

  socialBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 13,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  socialText: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.ink,
  },
  socialBtnDark: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 13,
    borderRadius: 999,
    backgroundColor: colors.ink,
  },
  socialTextDark: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.paper,
  },
  googleGlyph: {
    width: 18,
    height: 18,
  },
  appleGlyph: {
    width: 15,
    height: 18,
    marginTop: -2,
    tintColor: colors.paper,
  },

  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    marginBottom: 6,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line,
  },
  dividerText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.fg3,
  },
  loginPrimaryText: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.paper,
  },
  loginToggle: { paddingVertical: 10, alignItems: 'center' },
  loginToggleText: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.sageDeep,
  },
  debugHint: {
    marginTop: 12,
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.fg4,
    textAlign: 'center',
  },

  speech: { flexDirection: 'row', gap: 12, paddingHorizontal: 20, paddingTop: 24 },
  speechText: {
    fontFamily: fonts.display, fontSize: 20, lineHeight: 26,
    letterSpacing: -0.3, color: colors.ink,
  },

  section: { paddingHorizontal: 20, paddingTop: 24 },
  sectionClip: { overflow: 'hidden' },
  collapseHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontFamily: fonts.display, fontSize: 22, letterSpacing: -0.44, color: colors.ink },
  inkRule: { height: 1, backgroundColor: colors.ink, marginTop: 4 },
  emptyText: {
    paddingVertical: 20,
    fontFamily: 'Inter_500Medium_Italic',
    fontSize: 13,
    color: colors.fg3,
  },

  workRow: {
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line,
  },
  workHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14,
  },
  workHeaderPressed: { opacity: 0.55 },
  workTitle: { fontFamily: fonts.uiSemi, fontSize: 14.5, color: colors.ink },
  workMeta: { marginTop: 2, fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg3 },
  workVal: { fontFamily: fonts.ui, fontSize: 13, color: colors.sageDeep },
  workOptions: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    paddingBottom: 14,
  },
  workOption: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line,
    backgroundColor: colors.paper,
  },
  workOptionOn: {
    borderColor: colors.sageDeep,
    backgroundColor: colors.sageSoft,
  },
  workOptionPressed: { opacity: 0.6 },
  workOptionText: { fontFamily: fonts.ui, fontSize: 13, color: colors.fg2 },
  workOptionTextOn: { color: colors.sageDeep, fontFamily: fonts.uiSemi },

  // morning-brief row when only iCloud is connected — disabled visual + 'Læs mere' link to the explainer sheet.
  disabledPrefRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line,
    opacity: 0.65,
  },
  linkText: {
    fontFamily: fonts.uiSemi, fontSize: 13,
    color: colors.sageDeep,
    textDecorationLine: 'underline',
  },

  connRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14,
  },
  connBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  connRowPressed: { opacity: 0.55 },
  connRowComingSoon: { opacity: 0.45 },
  connectPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.ink,
  },
  connectPillText: {
    fontFamily: fonts.uiSemi,
    fontSize: 11.5,
    color: colors.paper,
  },
  logoBox: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 32, height: 32 },
  connTitle: { fontFamily: fonts.uiSemi, fontSize: 14.5, color: colors.ink },
  connSub: { marginTop: 2, fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg3 },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  statusSage: { backgroundColor: colors.sageSoft },
  statusWarn: { backgroundColor: colors.warningSoft },
  statusNeutral: { backgroundColor: colors.mist },
  statusText: { fontFamily: fonts.uiSemi, fontSize: 11.5 },
  statusTextSage: { color: colors.sageDeep },
  statusTextWarn: { color: colors.warningInk },
  statusTextNeutral: { color: colors.fg3 },

  planRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, paddingVertical: 16 },
  planPrice: {
    fontFamily: fonts.display, fontSize: 48,
    letterSpacing: -1.92, lineHeight: 52, color: colors.ink,
  },
  planUnit: { fontSize: 18, fontFamily: fonts.displayItalic, color: colors.ink },
  planMeta: { flex: 1, fontFamily: fonts.ui, fontSize: 12.5, color: colors.fg3 },
  planButtons: { flexDirection: 'row', gap: 8, paddingBottom: 24 },
  btnInk: {
    backgroundColor: colors.ink, paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 999,
  },
  btnInkText: { color: colors.paper, fontFamily: fonts.uiSemi, fontSize: 13 },

  dark: {
    paddingVertical: 28,
    paddingHorizontal: 20,
    paddingBottom: 32,
    backgroundColor: colors.ink,
  },
  darkTitle: {
    fontFamily: fonts.displayItalic, fontSize: 22,
    letterSpacing: -0.33, color: colors.paper, lineHeight: 26,
  },
  darkBody: {
    marginTop: 10,
    fontFamily: fonts.ui, fontSize: 14, lineHeight: 21, color: colors.paperOn75,
  },
  darkStrong: { color: colors.paper, fontFamily: fonts.uiSemi },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toggleLabel: { flex: 1, fontFamily: fonts.ui, fontSize: 13.5, color: 'rgba(246,241,232,0.9)' },

  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
  },
  accountRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  accountRowPressed: { opacity: 0.55 },
  accountRowLabel: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.ink,
  },
  accountRowChevron: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.fg3,
  },
  accountRowDestructive: { color: colors.danger },

  signOutRow: {
    paddingVertical: 22,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  signOutText: {
    fontFamily: fonts.uiSemi,
    fontSize: 13,
    color: colors.warningInk,
  },

  // Notification toggles (light-background rows, separate from the dark ToggleRow above).
  // No horizontal padding — the parent section already insets by 20, matching the
  // privacy card's inset so labels/toggles share a vertical column across sections.
  ntRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  ntLabel: { fontSize: 15, color: colors.ink, fontFamily: fonts.ui, flex: 1 },
  permissionBanner: {
    padding: 12,
    backgroundColor: colors.clay,
    borderRadius: 12,
    marginTop: 8,
    marginBottom: 4,
  },
  permissionBannerText: { fontSize: 13, color: colors.paper, fontFamily: fonts.ui },

  // Stemmestyring section: explanatory body copy under the section title.
  // Matches the body-text treatment used elsewhere in the screen
  // (connSub / workMeta) — small UI-font, muted fg3.
  sectionBody: {
    marginTop: 10,
    fontFamily: fonts.ui,
    fontSize: 13,
    lineHeight: 19,
    color: colors.fg3,
  },

  // Stemmestyring label rows ("Arbejdskalender" / "Privatkalender").
  // Visual model follows accountRow / accountRowLabel / accountRowChevron
  // so the tap target reads as a navigation row consistent with "Konto".
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  rowLabel: {
    fontFamily: fonts.uiSemi,
    fontSize: 14.5,
    color: colors.ink,
  },
  rowValue: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.sageDeep,
  },

  // Picker modal — full-screen sheet on the screen's paper background so it
  // visually belongs to the same world as the underlying Settings page.
  modal: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  modalTitle: {
    fontFamily: fonts.display,
    fontSize: 20,
    letterSpacing: -0.4,
    color: colors.ink,
  },
  modalCancel: {
    fontFamily: fonts.uiSemi,
    fontSize: 14,
    color: colors.sageDeep,
  },
  pickerRow: {
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  pickerRowText: {
    fontFamily: fonts.ui,
    fontSize: 15,
    color: colors.ink,
  },
  pickerHeading: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.fg3,
    marginBottom: 6,
  },
});
