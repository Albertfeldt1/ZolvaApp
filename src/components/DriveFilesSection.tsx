import { ChevronDown, ChevronRight } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useTheme } from '../design/useTheme';
import { listAccessibleFiles, type DriveFile } from '../lib/google-drive';

type Props = {
  // Opens the Google Picker (state + modal live in the parent screen so the
  // overlay covers the full viewport rather than a scroll cell).
  onOpenPicker: () => void;
  // Bumped by the parent after a pick so the granted-files list refetches.
  refreshKey: number;
};

// The "files Zolva can see" management block shown under the Google Drive row
// in Settings. Under `drive.file` a query-less files.list returns exactly the
// granted files, so this is the source of truth - no local persistence.
//
// v1 revoke is all-or-nothing via "Fjern Google-konto helt" (there is no
// clean non-destructive per-file ungrant API under drive.file). Users can
// also remove access from Google's "Apps with access" page.
export function DriveFilesSection({ onOpenPicker, refreshKey }: Props) {
  const { t, type, fonts, radius, spacing, surface } = useTheme();
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // The granted-files list collapses so it doesn't clutter Settings - the
  // header always shows the count, tap to expand. Default collapsed.
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    listAccessibleFiles()
      .then((rows) => {
        if (!cancelled) setFiles(rows);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <View style={{ paddingLeft: 52, paddingBottom: spacing.sm, gap: spacing.sm }}>
      <Pressable
        onPress={onOpenPicker}
        accessibilityRole="button"
        accessibilityLabel="Vælg filer Zolva kan se"
        style={({ pressed }) => ({
          alignSelf: 'flex-start',
          paddingVertical: spacing.xs,
          paddingHorizontal: spacing.md,
          borderRadius: radius.pill,
          backgroundColor: surface.glassWeak,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={{ fontFamily: fonts.uiBold, fontSize: 13, color: t.ink }}>
          Tilføj fil fra Drive
        </Text>
      </Pressable>
      <Text style={{ ...type.caption, color: t.ink3 }}>
        Vælg én fil ad gangen — hver fil lægges til listen herunder.
      </Text>

      {loading ? (
        <ActivityIndicator color={t.cal} style={{ alignSelf: 'flex-start' }} />
      ) : failed ? (
        <Text style={{ ...type.caption, color: t.ink3 }}>
          Kunne ikke hente filer. Prøv igen.
        </Text>
      ) : files.length === 0 ? (
        <Text style={{ ...type.caption, color: t.ink3 }}>
          Ingen filer valgt endnu. Vælg filer, så Zolva kan læse dem.
        </Text>
      ) : (
        <View style={{ gap: spacing.xs }}>
          <Pressable
            onPress={() => setExpanded((e) => !e)}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${files.length} filer Zolva kan se`}
            hitSlop={6}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.xs,
              alignSelf: 'flex-start',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            {expanded ? (
              <ChevronDown size={16} color={t.ink3} strokeWidth={2.2} />
            ) : (
              <ChevronRight size={16} color={t.ink3} strokeWidth={2.2} />
            )}
            <Text style={{ ...type.caption, color: t.ink2, fontFamily: fonts.uiBold }}>
              {files.length} {files.length === 1 ? 'fil' : 'filer'} Zolva kan se
            </Text>
          </Pressable>
          {expanded && (
            <View style={{ gap: 2, paddingLeft: spacing.lg }}>
              {files.map((f) => (
                <Text
                  key={f.id}
                  numberOfLines={1}
                  style={{ ...type.caption, color: t.ink2 }}
                >
                  · {f.name}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
