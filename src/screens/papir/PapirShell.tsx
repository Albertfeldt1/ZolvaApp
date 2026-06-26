import React, { useState } from 'react';
import { View } from 'react-native';
import { papirColor } from '../../design/papir';
import { PapirHome } from './PapirHome';
import { PapirPlan } from './PapirPlan';
import { PapirHistory } from './PapirHistory';
import { PapirProfile } from './PapirProfile';
import { PapirBottomNav, type PapirTab } from './PapirBottomNav';

/** Self-contained Papir preview shell: active tab screen + bottom nav. */
export function PapirShell() {
  const [tab, setTab] = useState<PapirTab>('home');
  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
      {tab === 'home' ? (
        <PapirHome />
      ) : tab === 'plan' ? (
        <PapirPlan />
      ) : tab === 'history' ? (
        <PapirHistory />
      ) : (
        <PapirProfile />
      )}
      <PapirBottomNav active={tab} onChange={setTab} onRecord={() => {}} />
    </View>
  );
}
