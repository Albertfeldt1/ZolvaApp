import React from 'react';
import { Text, type StyleProp, type TextProps, type TextStyle } from 'react-native';
import { papirColor, papirTabular, papirType } from '../tokens';

type Role = keyof typeof papirType;

// Omit RN's built-in ARIA `role` prop — it collides with our type-role prop
// (its union shares 'button'/'heading' with our roles, which would silently
// narrow `role` to just those two).
type Props = Omit<TextProps, 'role'> & {
  role?: Role;
  color?: string;
  tabular?: boolean;
  style?: StyleProp<TextStyle>;
};

/** Text bound to a Papir type role + color token. Default: body / ink. */
export function PaperText({ role = 'body', color = papirColor.ink, tabular, style, ...rest }: Props) {
  return <Text {...rest} style={[papirType[role], { color }, tabular ? papirTabular : null, style]} />;
}
