import React, { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, Text, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Stone } from '../design/primitives/Stone';
import { useTheme } from '../design/useTheme';
import { ProviderAuthError } from '../lib/auth';
import { getValidatedGoogleToken } from '../lib/google-drive';

export type PickedDriveFile = { id: string; name: string; mimeType: string };

type Props = {
  visible: boolean;
  onClose: () => void;
  onPicked: (files: PickedDriveFile[]) => void;
};

const PICKER_URL = `${(process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1/drive-picker`;
const PICKER_ORIGIN = (() => {
  try {
    return new URL(PICKER_URL).origin;
  } catch {
    return '';
  }
})();
const PICKER_HOST = (() => {
  try {
    return new URL(PICKER_URL).hostname;
  } catch {
    return '';
  }
})();

// The WebView carries a live Google OAuth token (injected into the main frame
// only — see injectedJavaScriptBeforeContentLoadedForMainFrameOnly). To keep
// that token from ever reaching an untrusted page, we lock navigation down to
// our own picker origin (derived from EXPO_PUBLIC_SUPABASE_URL — may be a
// custom domain like auth.zolva.io, NOT necessarily *.supabase.co) plus the
// Google domains the Picker itself loads, and reject anything else. https-only
// check; the Picker's own about:/data:/blob: frames pass through.
const ALLOWED_ORIGIN_PATTERNS = [
  PICKER_ORIGIN,
  'https://*.google.com',
  'https://*.gstatic.com',
  'https://*.googleapis.com',
  'https://*.googleusercontent.com',
];
function isAllowedHost(u: string): boolean {
  try {
    const h = new URL(u).hostname;
    return (
      h === PICKER_HOST ||
      h === 'google.com' ||
      h.endsWith('.google.com') ||
      h.endsWith('.googleapis.com') ||
      h.endsWith('.gstatic.com') ||
      h.endsWith('.googleusercontent.com')
    );
  } catch {
    return false;
  }
}

// NOTE: Google Picker multi-select is broken in mobile layouts (Google bug
// issuetracker.google.com/issues/334994030) and the Picker iframe keys its
// layout off the WebView's narrow viewport, not the User-Agent - so a desktop
// UA does NOT restore multi-select here. We accept single-pick: each pick adds
// a file to the drive.file grant set cumulatively, so users build the set up
// one file at a time (the Settings list reflects the running total).

type Phase = 'loading' | 'ready' | 'error';

// Google Drive file picker. Loads the drive-picker edge function in a WebView
// and injects a freshly-validated Google OAuth token BEFORE the page's scripts
// run (so it never travels in a URL). Selecting a file grants Zolva per-file
// `drive.file` access; the picked IDs come back via postMessage.
//
// Rendered as an Animated.View overlay rather than a native <Modal>: racing
// native modals on iOS leaves a phantom modal that eats all touches (see the
// signature-preview / onboarding flows). The overlay stacks cleanly.
export function DrivePickerModal({ visible, onClose, onPicked }: Props) {
  const { t, type, fonts, spacing } = useTheme();
  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    if (!visible) {
      // Reset for next open so a stale token/error never flashes.
      setPhase('loading');
      setToken(null);
      setErrorMsg('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const fresh = await getValidatedGoogleToken();
        if (cancelled) return;
        setToken(fresh);
        setPhase('ready');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(
          err instanceof ProviderAuthError
            ? 'Forbind Google igen for at vælge filer.'
            : 'Kunne ikke åbne filvælgeren. Prøv igen.',
        );
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const onMessage = (e: WebViewMessageEvent) => {
    // Only trust messages from our own picker page, never from an embedded
    // Google frame or a navigated-away origin.
    const srcUrl = e.nativeEvent.url ?? '';
    if (srcUrl && PICKER_ORIGIN && !srcUrl.startsWith(PICKER_ORIGIN)) return;
    let msg: { type?: string; files?: PickedDriveFile[]; message?: string };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'picked') {
      onPicked(Array.isArray(msg.files) ? msg.files : []);
      onClose();
    } else if (msg.type === 'cancel') {
      onClose();
    } else if (msg.type === 'error') {
      setErrorMsg('Kunne ikke åbne filvælgeren. Prøv igen.');
      setPhase('error');
    }
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, backgroundColor: t.paper }}
      entering={SlideInDown.duration(320)}
      exiting={SlideOutDown.duration(260)}
    >
      <SafeAreaView style={{ flex: 1 }}>
        {/* Header */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: spacing.screenPad,
            paddingVertical: spacing.md,
          }}
        >
          <Text style={{ fontFamily: fonts.display, fontSize: 20, color: t.ink }}>
            Vælg filer
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Luk"
            hitSlop={12}
          >
            <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: t.ink2 }}>Luk</Text>
          </Pressable>
        </View>

        <View style={{ flex: 1 }}>
          {phase === 'ready' && token ? (
            <WebView
              source={{ uri: PICKER_URL }}
              originWhitelist={ALLOWED_ORIGIN_PATTERNS}
              onShouldStartLoadWithRequest={(req) => {
                // Block navigation to any non-allowlisted https origin so the
                // token-bearing main frame can't be redirected somewhere
                // untrusted. Non-http schemes (the Picker's about:/data:/blob:
                // frames) pass through.
                if (!/^https?:/i.test(req.url)) return true;
                return isAllowedHost(req.url);
              }}
              injectedJavaScriptBeforeContentLoaded={`window.__ZOLVA_OAUTH_TOKEN=${JSON.stringify(token)};true;`}
              injectedJavaScriptBeforeContentLoadedForMainFrameOnly
              onMessage={onMessage}
              onError={() => {
                setErrorMsg('Kunne ikke åbne filvælgeren. Prøv igen.');
                setPhase('error');
              }}
              onHttpError={() => {
                setErrorMsg('Kunne ikke åbne filvælgeren. Prøv igen.');
                setPhase('error');
              }}
              style={{ flex: 1, backgroundColor: 'transparent' }}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl }}>
              <Stone mood={phase === 'error' ? 'calm' : 'thinking'} size={64} jumpOnTap={false} />
              {phase === 'error' ? (
                <>
                  <Text style={{ ...type.body, color: t.ink2, textAlign: 'center' }}>{errorMsg}</Text>
                  <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Luk">
                    <Text style={{ fontFamily: fonts.uiBold, fontSize: 15, color: t.ink }}>Luk</Text>
                  </Pressable>
                </>
              ) : (
                <Text style={{ ...type.body, color: t.ink3 }}>Åbner Google Drive…</Text>
              )}
            </View>
          )}
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}
