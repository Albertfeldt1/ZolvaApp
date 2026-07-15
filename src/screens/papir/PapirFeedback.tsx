import React, { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { X } from 'lucide-react-native';
import { ScaleButton } from '../../design/motion';
import { Button, PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';
import { submitFeedback, type FeedbackKind } from '../../lib/feedback';

const KIND_META: Record<FeedbackKind, { label: string; placeholder: string }> = {
  bug: { label: 'Fejl', placeholder: 'Hvad skete der — og hvad havde du forventet?' },
  idea: { label: 'Forslag', placeholder: 'Hvad ønsker du dig, at Zolva kunne?' },
};

/** Beta-feedback: fejl eller forslag, ét tekstfelt, send. Åbnes fra Profil.
 * RN Modal (pageSheet) fremfor inline overlay — samme begrundelse som
 * PapirChats recorder: kun en Modal lægger sig over shellens bottom nav. */
export function PapirFeedback({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const reset = () => {
    setKind('bug');
    setMessage('');
    setSending(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const send = async () => {
    setSending(true);
    const result = await submitFeedback(kind, message);
    setSending(false);
    if (!result.ok) {
      Alert.alert(
        'Feedback',
        result.reason === 'no-session'
          ? 'Log ind for at sende feedback.'
          : 'Kunne ikke sende lige nu. Tjek din forbindelse og prøv igen.',
      );
      return;
    }
    close();
    Alert.alert('Tak!', 'Vi læser al feedback — det er den, der former Zolva.');
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, backgroundColor: papirColor.paper }}
      >
        <View style={{ flex: 1, padding: papirSpace.screen, paddingTop: 22 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <PaperText role="titleSerif" style={{ fontSize: 24 }}>
              Feedback
            </PaperText>
            <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel="Luk">
              <X size={22} color={papirColor.ink2} strokeWidth={2} />
            </Pressable>
          </View>
          <PaperText role="caption" color={papirColor.ink3} style={{ marginTop: 6 }}>
            Fandt du en fejl, eller mangler der noget? Vi svarer måske ikke på alt, men vi læser alt.
          </PaperText>

          <View style={{ flexDirection: 'row', gap: 10, marginTop: papirSpace.xl }}>
            {(Object.keys(KIND_META) as FeedbackKind[]).map((k) => {
              const active = kind === k;
              return (
                <ScaleButton
                  key={k}
                  scaleTo={0.96}
                  haptic="selection"
                  onPress={() => setKind(k)}
                  accessibilityRole="button"
                  accessibilityLabel={KIND_META[k].label}
                  style={{
                    paddingVertical: 9,
                    paddingHorizontal: 18,
                    borderRadius: papirRadius.pill,
                    borderWidth: 1,
                    borderColor: active ? papirColor.ink : papirColor.line,
                    backgroundColor: active ? papirColor.ink : papirColor.card,
                  }}
                >
                  <PaperText role="small" color={active ? papirColor.onInk : papirColor.ink}>
                    {KIND_META[k].label}
                  </PaperText>
                </ScaleButton>
              );
            })}
          </View>

          <View
            style={{
              marginTop: papirSpace.lg,
              borderWidth: 1,
              borderColor: papirColor.line,
              borderRadius: papirRadius.xl,
              backgroundColor: papirColor.card,
              padding: 14,
            }}
          >
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder={KIND_META[kind].placeholder}
              placeholderTextColor={papirColor.ink4}
              selectionColor={papirColor.red}
              multiline
              maxLength={4000}
              autoFocus
              style={{
                minHeight: 140,
                fontSize: 15,
                color: papirColor.ink,
                textAlignVertical: 'top',
                paddingTop: 0,
              }}
            />
          </View>

          <View style={{ marginTop: papirSpace.lg }}>
            <Button
              label={sending ? 'Sender…' : 'Send'}
              variant="primary"
              disabled={sending || !message.trim()}
              onPress={() => void send()}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
