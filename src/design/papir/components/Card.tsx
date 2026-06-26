import React from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { papirColor, papirRadius, papirSpace } from '../tokens';

type Props = ViewProps & {
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
};

/** Standard paper card: white surface, hairline border, 20-radius. */
export function Card({ style, padded = true, children, ...rest }: Props) {
  return (
    <View
      {...rest}
      style={[
        {
          backgroundColor: papirColor.card,
          borderWidth: 1,
          borderColor: papirColor.line,
          borderRadius: papirRadius.xxl,
          padding: padded ? papirSpace.base : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
