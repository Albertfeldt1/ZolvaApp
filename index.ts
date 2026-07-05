import './src/lib/cryptoPolyfill';

import { registerRootComponent } from 'expo';

import App from './App';
import PapirPreviewRoot from './src/screens/papir/PapirPreviewRoot';

// DEV PREVIEW SWITCH: lets us see the Papir redesign in the simulator without
// touching App.tsx or the real nav. Gated on __DEV__ so a release build (or an
// EAS Update published from this branch) can NEVER ship the preview instead of
// the real app — flipping the boolean only has effect in dev.
const PAPIR_PREVIEW = __DEV__ && true;

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(PAPIR_PREVIEW ? PapirPreviewRoot : App);
