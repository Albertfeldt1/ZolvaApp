import { X } from 'lucide-react-native';
import React from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Avatar } from './Avatar';
import { EmptyState } from './EmptyState';
import { useInboxArchived } from '../lib/hooks';
import type { InboxMail, MailProvider } from '../lib/types';
import { colors, fonts } from '../theme';

const PROVIDER_LOGOS: Record<MailProvider, ReturnType<typeof require>> = {
  google: require('../../assets/logos/gmail.png'),
  microsoft: require('../../assets/logos/outlook-mail.png'),
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onOpenMail: (mail: InboxMail) => void;
};

export function ArchiveModal({ visible, onClose, onOpenMail }: Props) {
  const { data: archived, loading, error } = useInboxArchived();

  const handleOpen = (mail: InboxMail) => {
    onClose();
    onOpenMail(mail);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <View style={styles.topBar}>
          <View style={styles.eyebrowWrap}>
            <Text style={styles.eyebrow}>Arkiv</Text>
            <Text style={styles.count}>
              {archived.length > 0 ? `${archived.length} mails` : '-'}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            style={styles.closeBtn}
            hitSlop={12}
            accessibilityLabel="Luk arkiv"
          >
            <X size={18} color={colors.ink} strokeWidth={1.75} />
          </Pressable>
        </View>

        <Text style={styles.headline}>Arkiverede mails</Text>
        <View style={styles.inkRule} />

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {archived.length === 0 ? (
            <EmptyState
              mood="calm"
              title={error ? 'Kunne ikke hente arkiv' : 'Intet i arkivet endnu'}
              body={
                error
                  ? 'Prøv igen om lidt.'
                  : loading
                    ? 'Henter…'
                    : 'Mails du arkiverer i Zolva dukker op her.'
              }
            />
          ) : (
            archived.map((m, i) => (
              <Pressable
                key={m.id}
                onPress={() => handleOpen(m)}
                style={({ pressed }) => [
                  styles.row,
                  i > 0 && styles.rowBorder,
                  pressed && styles.rowPressed,
                ]}
              >
                <View style={styles.avatarWrap}>
                  <Avatar initials={m.initials} tone={m.tone} />
                  <View style={styles.providerBadge}>
                    <Image
                      source={PROVIDER_LOGOS[m.provider]}
                      style={styles.providerLogo}
                      resizeMode="contain"
                    />
                  </View>
                </View>
                <View style={styles.rowBody}>
                  <View style={styles.rowTopLine}>
                    <Text style={styles.sender} numberOfLines={1}>{m.from}</Text>
                    <Text style={styles.time}>{m.time}</Text>
                  </View>
                  <Text style={styles.subject} numberOfLines={2}>{m.subject}</Text>
                </View>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 18,
    paddingHorizontal: 22,
    paddingBottom: 4,
  },
  eyebrowWrap: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  eyebrow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.88,
    textTransform: 'uppercase',
    color: colors.sageDeep,
  },
  count: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.fg3,
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    backgroundColor: colors.mist,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headline: {
    marginTop: 8,
    paddingHorizontal: 22,
    fontFamily: fonts.displayItalic,
    fontSize: 30,
    lineHeight: 34,
    letterSpacing: -0.6,
    color: colors.ink,
  },
  inkRule: {
    marginTop: 14,
    marginHorizontal: 22,
    height: 1,
    backgroundColor: colors.ink,
  },

  scroll: { paddingHorizontal: 22, paddingTop: 4, paddingBottom: 40 },

  row: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 14 },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowPressed: { opacity: 0.6 },
  avatarWrap: { position: 'relative' },
  providerBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 16,
    height: 16,
    borderRadius: 999,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  providerLogo: { width: 11, height: 11 },
  rowBody: { flex: 1, minWidth: 0 },
  rowTopLine: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  sender: { flex: 1, fontFamily: fonts.uiSemi, fontSize: 14, color: colors.ink },
  time: { fontFamily: fonts.mono, fontSize: 11, color: colors.fg3 },
  subject: { marginTop: 2, fontFamily: fonts.ui, fontSize: 13.5, color: colors.fg2 },
});
