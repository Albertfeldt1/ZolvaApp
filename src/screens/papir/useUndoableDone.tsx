// Undo for "markér som klaret" (QA M7). There is no un-done API, so the
// commit is DELAYED instead: the row flips visually at once, a snackbar
// offers "Fortryd" for a few seconds, and only then does markDone hit the
// server. Undo simply cancels the pending commit.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScaleButton } from '../../design/motion';
import { PaperText, papirColor, papirRadius, papirSpace } from '../../design/papir';

const UNDO_WINDOW_MS = 3_500;

export function useUndoableDone(commit: (id: string) => void): {
  /** Treat these ids as done in the UI even though the server hasn't heard yet. */
  pendingDoneIds: ReadonlySet<string>;
  markDone: (id: string) => void;
  /** Render OUTSIDE the ScrollView — it is absolutely positioned. */
  snackbar: React.ReactNode;
} {
  const [pending, setPending] = useState<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Commit everything still pending if the screen unmounts — "klaret" must
  // never silently un-happen because the user navigated away.
  useEffect(() => {
    return () => {
      pendingRef.current.forEach((timer, id) => {
        clearTimeout(timer);
        commit(id);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markDone = useCallback(
    (id: string) => {
      if (pendingRef.current.has(id)) return;
      const timer = setTimeout(() => {
        commit(id);
        setPending((m) => {
          const next = new Map(m);
          next.delete(id);
          return next;
        });
      }, UNDO_WINDOW_MS);
      setPending((m) => new Map(m).set(id, timer));
    },
    [commit],
  );

  const undoAll = useCallback(() => {
    pendingRef.current.forEach((timer) => clearTimeout(timer));
    setPending(new Map());
  }, []);

  const insets = useSafeAreaInsets();
  const navHeight = 68 + Math.max(insets.bottom, 16);
  const snackbar =
    pending.size > 0 ? (
      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', left: 0, right: 0, bottom: navHeight + 8, zIndex: 65, alignItems: 'center' }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            backgroundColor: papirColor.ink,
            borderRadius: papirRadius.pill,
            paddingVertical: 10,
            paddingLeft: 18,
            paddingRight: 8,
            marginHorizontal: papirSpace.screen,
          }}
        >
          <PaperText role="small" color={papirColor.onInk}>
            {pending.size === 1 ? 'Opgave klaret' : `${pending.size} opgaver klaret`}
          </PaperText>
          <ScaleButton
            scaleTo={0.94}
            haptic="light"
            onPress={undoAll}
            accessibilityRole="button"
            accessibilityLabel="Fortryd"
            style={{
              backgroundColor: 'rgba(255,255,255,0.14)',
              paddingVertical: 6,
              paddingHorizontal: 14,
              borderRadius: papirRadius.pill,
            }}
          >
            <PaperText role="small" color={papirColor.onInk}>
              Fortryd
            </PaperText>
          </ScaleButton>
        </View>
      </View>
    ) : null;

  return { pendingDoneIds: new Set(pending.keys()), markDone, snackbar };
}
