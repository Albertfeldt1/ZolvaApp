import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

const mockSignInWithGoogle = jest.fn().mockResolvedValue({ error: null });
const mockSignInWithMicrosoft = jest.fn().mockResolvedValue({ error: null });
const mockSignInWithApple = jest.fn().mockResolvedValue({ error: null });

jest.mock('../../lib/auth', () => ({
  useAuth: () => ({
    signInWithGoogle: mockSignInWithGoogle,
    signInWithMicrosoft: mockSignInWithMicrosoft,
    signInWithApple: mockSignInWithApple,
    appleAvailable: true,
  }),
}));

import { AuthSheet } from '../AuthSheet';

describe('AuthSheet', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders the three account providers', async () => {
    const { getByText } = await render(<AuthSheet onClose={() => {}} />);
    expect(getByText('Fortsæt med Apple')).toBeTruthy();
    expect(getByText('Fortsæt med Google')).toBeTruthy();
    expect(getByText('Fortsæt med Microsoft')).toBeTruthy();
  });

  it('does NOT render an iCloud sign-in button', async () => {
    const { queryByText } = await render(<AuthSheet onClose={() => {}} />);
    expect(queryByText('Fortsæt med iCloud')).toBeNull();
  });

  it('calls signInWithGoogle when the Google button is tapped', async () => {
    const { getByText } = await render(<AuthSheet onClose={() => {}} />);
    fireEvent.press(getByText('Fortsæt med Google'));
    expect(mockSignInWithGoogle).toHaveBeenCalledTimes(1);
  });
});
