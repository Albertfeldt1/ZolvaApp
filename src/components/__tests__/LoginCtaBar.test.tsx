import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { LoginCtaBar } from '../LoginCtaBar';

describe('LoginCtaBar', () => {
  it('renders the Danish CTA label', async () => {
    const { getByText } = await render(<LoginCtaBar onPress={() => {}} />);
    expect(getByText('Log ind for at komme i gang')).toBeTruthy();
  });

  it('calls onPress when tapped', async () => {
    const onPress = jest.fn();
    const { getByText } = await render(<LoginCtaBar onPress={onPress} />);
    fireEvent.press(getByText('Log ind for at komme i gang'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
