import React, { useEffect, useState } from 'react';
import { Text, TextProps } from 'react-native';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type CountUpProps = {
  to: number;
  dur?: number;
  suffix?: string;
  style?: TextProps['style'];
};

export function CountUp({ to, dur = 900, suffix = '', style }: CountUpProps) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const start = now();
    let raf: number;
    const tick = () => {
      const p = Math.min(1, (now() - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(Math.round(eased * to));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, dur]);
  return <Text style={style}>{v}{suffix}</Text>;
}
