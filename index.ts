import './src/lib/cryptoPolyfill';

import { registerRootComponent } from 'expo';

import App from './App';
import PapirPreviewRoot from './src/screens/papir/PapirPreviewRoot';

// DEV PREVIEW SWITCH: flip to false to restore the real app. Lets us see the
// Papir redesign in the simulator without touching App.tsx or the real nav.
const PAPIR_PREVIEW = true;

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(PAPIR_PREVIEW ? PapirPreviewRoot : App);
