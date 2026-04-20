import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme';

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (__DEV__) console.warn('[ErrorBoundary] caught:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.root}>
        <Text style={styles.title}>Noget gik galt</Text>
        <Text style={styles.body}>Prøv at genstarte appen.</Text>
        <Pressable
          onPress={this.reset}
          style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Prøv igen"
        >
          <Text style={styles.btnText}>Prøv igen</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  title: {
    fontFamily: fonts.displayItalic,
    fontSize: 28,
    color: colors.ink,
    textAlign: 'center',
  },
  body: {
    fontFamily: fonts.ui,
    fontSize: 14,
    color: colors.fg2,
    textAlign: 'center',
  },
  btn: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: colors.ink,
    borderRadius: 999,
  },
  btnPressed: { opacity: 0.75 },
  btnText: {
    fontFamily: fonts.uiSemi,
    fontSize: 14,
    color: colors.paper,
  },
});
