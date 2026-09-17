import { describe, expect, it } from 'vitest';
import { PIN_COLORS, PIN_ICONS } from '@echozedlabs/ui';
import { colorName, iconName, knownToken } from './choicePickerModel.js';

describe('choice names', () => {
  it('names colours and icons for people, keeping every name distinct', () => {
    expect(colorName('teal')).toBe('Teal');
    expect(iconName('diagramProject')).toBe('Diagram project');
    expect(iconName('book')).toBe('Book');
    expect(new Set(PIN_COLORS.map(colorName)).size).toBe(PIN_COLORS.length);
    expect(new Set(PIN_ICONS.map(iconName)).size).toBe(PIN_ICONS.length);
  });

  it('treats an unknown stored token as nothing chosen', () => {
    expect(knownToken('violet', PIN_COLORS)).toBe('violet');
    expect(knownToken('hotpink', PIN_COLORS)).toBe('');
    expect(knownToken(null, PIN_ICONS)).toBe('');
    // Case-sensitive, as the server is for icons.
    expect(knownToken('bookopen', PIN_ICONS)).toBe('');
  });
});
