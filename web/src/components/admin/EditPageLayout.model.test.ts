import { describe, expect, it } from 'vitest';
import { isSaveShortcut, saveStatus } from './EditPageLayout.model.js';
import { formFieldDescribedBy, formFieldErrorId, formFieldHelperId } from './FormField.js';

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('isSaveShortcut', () => {
  it('accepts Ctrl+S and Cmd+S in either case', () => {
    expect(isSaveShortcut(key('s', { ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(key('S', { metaKey: true }))).toBe(true);
  });

  it('rejects plain S and Shift/Alt variants', () => {
    expect(isSaveShortcut(key('s'))).toBe(false);
    expect(isSaveShortcut(key('s', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSaveShortcut(key('s', { metaKey: true, altKey: true }))).toBe(false);
    expect(isSaveShortcut(key('d', { ctrlKey: true }))).toBe(false);
  });
});

describe('saveStatus', () => {
  it('explains the Save button state in words', () => {
    expect(saveStatus({ isDirty: true, isSaving: true, canSave: true })).toEqual({ status: 'saving', text: 'Saving…' });
    expect(saveStatus({ isDirty: true, isSaving: false, canSave: true })).toEqual({ status: 'unsaved', text: 'Unsaved changes' });
    expect(saveStatus({ isDirty: true, isSaving: false, canSave: false }).status).toBe('blocked');
    expect(saveStatus({ isDirty: false, isSaving: false, canSave: true })).toEqual({ status: 'ready', text: '' });
    expect(saveStatus({ isDirty: false, isSaving: false, canSave: false })).toEqual({ status: 'clean', text: 'No changes to save' });
  });
});

describe('FormField id convention', () => {
  it('derives helper and error ids from htmlFor', () => {
    expect(formFieldHelperId('section-name')).toBe('section-name-helper');
    expect(formFieldErrorId('section-name')).toBe('section-name-error');
  });

  it('builds aria-describedby from what is present, error first', () => {
    expect(formFieldDescribedBy('f', {})).toBeUndefined();
    expect(formFieldDescribedBy('f', { helper: 'Shown on the site' })).toBe('f-helper');
    expect(formFieldDescribedBy('f', { error: 'Required' })).toBe('f-error');
    expect(formFieldDescribedBy('f', { helper: 'x', error: 'Required' })).toBe('f-error f-helper');
    expect(formFieldDescribedBy('f', { helper: 'x', error: null })).toBe('f-helper');
  });
});
