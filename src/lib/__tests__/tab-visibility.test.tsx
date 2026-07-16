import React from 'react';
import { act, render } from '@testing-library/react-native';
import { TabVisibilityProvider } from '../tab-visibility';
import { useNow } from '../../screens/papir/useNow';

// Fanger hookens seneste værdi uden at skulle rendere UI.
let lastNow: Date | null = null;
function Probe() {
  lastNow = useNow();
  return null;
}

// React 19's scheduler kører render-arbejde via timere, så under fake timers
// skal både mount/rerender (0 ms) og tidsforløb flushes inde i async act.
const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

describe('useNow + TabVisibilityProvider', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    lastNow = null;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ticks every minute without a provider (default visible)', async () => {
    await render(<Probe />);
    const first = lastNow!.getTime();
    await advance(60_000);
    expect(lastNow!.getTime()).toBeGreaterThanOrEqual(first + 60_000);
  });

  it('does not tick while the hosting pane is hidden', async () => {
    await render(
      <TabVisibilityProvider value={false}>
        <Probe />
      </TabVisibilityProvider>,
    );
    const first = lastNow!.getTime();
    await advance(5 * 60_000);
    expect(lastNow!.getTime()).toBe(first);
  });

  it('fires a fresh tick immediately when the pane becomes visible again', async () => {
    const ui = (visible: boolean) => (
      <TabVisibilityProvider value={visible}>
        <Probe />
      </TabVisibilityProvider>
    );
    const { rerender } = await render(ui(true));
    await advance(30_000);

    await rerender(ui(false));
    const hiddenAt = lastNow!.getTime();
    await advance(10 * 60_000);
    expect(lastNow!.getTime()).toBe(hiddenAt); // paused while hidden

    await rerender(ui(true));
    // Resume catches up straight away - no stale minute while waiting for
    // the next interval tick.
    expect(lastNow!.getTime()).toBeGreaterThanOrEqual(hiddenAt + 10 * 60_000);

    // ...and the interval keeps running afterwards.
    const resumedAt = lastNow!.getTime();
    await advance(60_000);
    expect(lastNow!.getTime()).toBeGreaterThanOrEqual(resumedAt + 60_000);
  });
});
