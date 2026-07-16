import React from 'react';
import { act, render } from '@testing-library/react-native';
import { Stone } from '../Stone';

// Røgtest for maskotten efter gaze-flytningen til Reanimated: mount, lad
// blink/gaze-løkkerne køre nogle cyklusser, og unmount uden fejl/lækage.
describe('Stone', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('mounts, runs its blink/gaze loops, and unmounts cleanly', async () => {
    const { unmount } = await render(<Stone />);
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    await unmount();
    // Blink- og gaze-løkkerne genplanlægger sig selv, så en lækket løkke
    // holder permanent én pending timer hver (≥2 i alt). Efter unmount skal
    // alt dræne til højst test-runnerens egen rest (målt: 1 infra-timer).
    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });
    expect(jest.getTimerCount()).toBeLessThanOrEqual(1);
  });
});
