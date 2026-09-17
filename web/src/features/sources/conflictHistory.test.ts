/**
 * The resolved-conflict history (Sources → Conflicts) is rendered from the
 * server's own record, so the "By" column has to cope with what that record
 * actually holds: a joined username, or only the actor id once that user is
 * gone, or nothing at all on rows that were never resolved by a person.
 */
import { describe, expect, it } from 'vitest';
import { resolvedByLabel } from './types.js';

describe('resolvedByLabel', () => {
  it('prefers the username the server joined onto the row', () => {
    expect(resolvedByLabel({ resolved_by: 'usr_1', resolved_by_username: 'ada' })).toBe('ada');
  });

  it('falls back to the actor id when the user no longer exists', () => {
    expect(resolvedByLabel({ resolved_by: 'usr_1', resolved_by_username: null })).toBe('usr_1');
    expect(resolvedByLabel({ resolved_by: 'usr_1' })).toBe('usr_1');
  });

  it('never renders a blank cell', () => {
    expect(resolvedByLabel({ resolved_by: null, resolved_by_username: null })).toBe('Unknown');
    expect(resolvedByLabel({ resolved_by: '   ', resolved_by_username: '  ' })).toBe('Unknown');
  });
});
