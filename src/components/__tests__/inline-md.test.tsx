import React from 'react';
import { Text, Linking } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { renderInlineMd, renderLinks } from '../inline-md';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve()) }));
jest.mock('expo-haptics', () => ({ selectionAsync: jest.fn(() => Promise.resolve()) }));

const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);

beforeEach(() => openURL.mockClear());

describe('renderLinks', () => {
  it('opens a bare https link on tap', async () => {
    const { getByText } = await render(<Text>{renderLinks('se https://facebook.com/zolva her')}</Text>);
    fireEvent.press(getByText('https://facebook.com/zolva'));
    expect(openURL).toHaveBeenCalledWith('https://facebook.com/zolva');
  });

  it('prefixes www-links with https:// when opening', async () => {
    const { getByText } = await render(<Text>{renderLinks('gå til www.zolva.io')}</Text>);
    fireEvent.press(getByText('www.zolva.io'));
    expect(openURL).toHaveBeenCalledWith('https://www.zolva.io');
  });

  it('keeps sentence punctuation out of the link', async () => {
    const { getByText } = await render(<Text>{renderLinks('læs https://zolva.io/blog.')}</Text>);
    fireEvent.press(getByText('https://zolva.io/blog'));
    expect(openURL).toHaveBeenCalledWith('https://zolva.io/blog');
  });

  it('renders [label](url) markdown links as the label', async () => {
    const { getByText, queryByText } = await render(
      <Text>{renderLinks('se [min side](https://facebook.com/zolva) i dag')}</Text>,
    );
    expect(queryByText(/facebook\.com/)).toBeNull();
    fireEvent.press(getByText('min side'));
    expect(openURL).toHaveBeenCalledWith('https://facebook.com/zolva');
  });
});

describe('renderInlineMd', () => {
  it('links inside **bold** spans still open', async () => {
    const { getByText } = await render(<Text>{renderInlineMd('**vigtigt: https://zolva.io**', 'Font-Bold')}</Text>);
    fireEvent.press(getByText('https://zolva.io'));
    expect(openURL).toHaveBeenCalledWith('https://zolva.io');
  });

  it('renders *kursiv* without visible asterisks', async () => {
    const { getByText, queryByText } = await render(
      <Text>{renderInlineMd('Hovedstaden er Rom (italiensk: *Roma*).', 'Font-Bold')}</Text>,
    );
    expect(getByText('Roma')).toBeTruthy();
    expect(queryByText(/\*Roma\*/)).toBeNull();
  });

  it('renders italic inside a bold span without asterisks', async () => {
    const { getByText } = await render(<Text>{renderInlineMd('**fed med *kursiv* indeni**', 'Font-Bold')}</Text>);
    expect(getByText('kursiv')).toBeTruthy();
  });

  it('leaves list bullets and arithmetic asterisks alone', async () => {
    const { getByText } = await render(
      <Text>{renderInlineMd('* punkt et\n* punkt to og 2 * 3 = 6', 'Font-Bold')}</Text>,
    );
    expect(getByText(/\* punkt et/)).toBeTruthy();
    expect(getByText(/2 \* 3 = 6/)).toBeTruthy();
  });
});
