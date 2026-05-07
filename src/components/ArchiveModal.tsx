import { X } from 'lucide-react-native';
import React from 'react';
import {
  Image,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Avatar } from './Avatar';
import { EmptyState } from './EmptyState';
import { GlassFrostedCard } from '../design/primitives/GlassFrostedCard';
import { GlassHaloLayer } from '../design/primitives/GlassHaloLayer';
import { useTheme } from '../design/useTheme';
import { useInboxArchived } from '../lib/hooks';
import type { InboxMail, MailProvider } from '../lib/types';

const PROVIDER_LOGOS: Record<MailProvider, ReturnType<typeof require>> = {
  google: require('../../assets/logos/gmail.png'),
  microsoft: require('../../assets/logos/outlook-mail.png'),
  icloud: require('../../assets/logos/apple.png'),
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onOpenMail: (mail: InboxMail) => void;
};

export function ArchiveModal({ visible, onClose, onOpenMail }: Props) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const { data: archived, loading, error } = useInboxArchived();

  const handleOpen = (mail: InboxMail) => {
    onClose();
    onOpenMail(mail);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="overFullScreen"
      transparent
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, position: 'relative', backgroundColor: t.paper }}>
        <GlassHaloLayer />
        <SafeAreaView style={{ flex: 1 }}>

        {/* Header — glass card with × close + title */}
        <View
          style={{
            paddingTop: spacing.sm,
            paddingHorizontal: spacing.screenPad,
            paddingBottom: spacing.md,
            position: 'relative',
            zIndex: 1,
          }}
        >
          <GlassFrostedCard
            radius={radius.card}
            style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.cardPad }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Pressable
                onPress={onClose}
                hitSlop={12}
                accessibilityLabel="Luk arkiv"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: radius.pill,
                  backgroundColor: surface.iconButton,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <X size={18} color={t.ink2} strokeWidth={1.75} />
              </Pressable>

              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
                  <Text
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 11,
                      letterSpacing: 0.88,
                      textTransform: 'uppercase',
                      color: t.ink3,
                    }}
                  >
                    Arkiv
                  </Text>
                  {archived.length > 0 && (
                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: t.ink3 }}>
                      {`${archived.length} mails`}
                    </Text>
                  )}
                </View>
              </View>
            </View>
          </GlassFrostedCard>
        </View>

        {/* Hero headline */}
        <View style={{ paddingHorizontal: spacing.screenPad, paddingBottom: spacing.cardPad }}>
          <GlassFrostedCard overlay={surface.bone} radius={radius.card} style={{ paddingVertical: spacing.lg, paddingHorizontal: spacing.lg }}>
            <Text
              style={{
                fontFamily: fonts.display,
                fontStyle: 'italic',
                fontSize: 30,
                lineHeight: 34,
                letterSpacing: -0.6,
                color: t.ink,
              }}
            >
              Arkiverede mails
            </Text>
            <View
              style={{
                marginTop: 14,
                height: 1,
                backgroundColor: t.line,
              }}
            />
          </GlassFrostedCard>
        </View>

        {/* Mail list */}
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: spacing.screenPad,
            paddingBottom: spacing.xxl,
          }}
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
            <GlassFrostedCard overlay={surface.bone} radius={radius.card} style={{ paddingVertical: 0, paddingHorizontal: spacing.lg }}>
              {archived.map((m, i) => (
                <Pressable
                  key={m.id}
                  onPress={() => handleOpen(m)}
                  style={({ pressed }) => [
                    {
                      flexDirection: 'row',
                      gap: 12,
                      alignItems: 'flex-start',
                      paddingVertical: spacing.md,
                    },
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: t.line,
                    },
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  {/* Avatar + provider badge */}
                  <View style={{ position: 'relative' }}>
                    <Avatar initials={m.initials} tone={m.tone} />
                    {PROVIDER_LOGOS[m.provider] != null && (
                      <View
                        style={{
                          position: 'absolute',
                          right: -2,
                          bottom: -2,
                          width: 16,
                          height: 16,
                          borderRadius: radius.pill,
                          backgroundColor: t.paper,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderWidth: StyleSheet.hairlineWidth,
                          borderColor: t.line,
                        }}
                      >
                        <Image
                          source={PROVIDER_LOGOS[m.provider]}
                          style={{ width: 11, height: 11 }}
                          resizeMode="contain"
                        />
                      </View>
                    )}
                  </View>

                  {/* Row body */}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                      <Text
                        style={{ flex: 1, fontFamily: fonts.uiBold, fontSize: 14, color: t.ink }}
                        numberOfLines={1}
                      >
                        {m.from}
                      </Text>
                      <Text style={{ ...type.eyebrow, color: t.ink3, textTransform: 'none' }}>
                        {m.time}
                      </Text>
                    </View>
                    <Text
                      style={{ marginTop: 2, fontFamily: fonts.ui, fontSize: 13.5, color: t.ink2 }}
                      numberOfLines={2}
                    >
                      {m.subject}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </GlassFrostedCard>
          )}
        </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}
