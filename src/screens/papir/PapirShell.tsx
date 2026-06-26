import React, { useState } from 'react';
import { View } from 'react-native';
import { PaperText, papirColor } from '../../design/papir';
import { PapirHome } from './PapirHome';
import { PapirBottomNav, type PapirTab } from './PapirBottomNav';

function Placeholder({ label }: { label: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <PaperText role="displayS">{label}</PaperText>
      <PaperText role="small" color={papirColor.ink3}>
        Kommer snart
      </PaperText>
    </View>
  );
}

const TAB_LABEL: Record<Exclude<PapirTab, 'home'>, string> = {
  plan: 'Plan',
  history: 'Historik',
  profile: 'Profil',
};

/** Self-contained Papir preview shell: active screen + bottom nav. */
export function PapirShell() {
  const [tab, setTab] = useState<PapirTab>('home');
  return (
    <View style={{ flex: 1, backgroundColor: papirColor.paper }}>
      {tab === 'home' ? <PapirHome /> : <Placeholder label={TAB_LABEL[tab]} />}
      <PapirBottomNav active={tab} onChange={setTab} onRecord={() => {}} />
    </View>
  );
}
