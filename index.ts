import './src/lib/cryptoPolyfill';

import { registerRootComponent } from 'expo';
import * as Sentry from '@sentry/react-native';

import App from './App';

// Crash-rapportering: no-op indtil EXPO_PUBLIC_SENTRY_DSN er sat (EAS env /
// .env). Init så tidligt som muligt, så boot-crashes også fanges. Sourcemap-
// upload (læsbare JS-stacktraces) kræver desuden SENTRY_ORG/SENTRY_PROJECT/
// SENTRY_AUTH_TOKEN som EAS-secrets — uden dem rapporteres fejl stadig, blot
// med minificerede stacks.
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Kun fejl/crashes i beta — ingen performance-tracing, holder trafik og
    // kvote nede.
    tracesSampleRate: 0,
  });
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately.
//
// The Papir redesign no longer swaps the root here — it mounts INSIDE App
// behind a dev-only runtime toggle (src/lib/papir-flag.ts), so auth, push,
// premium and all boot effects work identically in both UIs.
registerRootComponent(SENTRY_DSN ? Sentry.wrap(App) : App);
