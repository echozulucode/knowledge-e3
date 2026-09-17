import { describe, expect, it } from 'vitest';
import type { AuthSettings, SettingProvenance } from '../queries.js';
import {
  attemptLimitText,
  draftToPolicy,
  durationText,
  isPolicyDirty,
  lifetimeOptions,
  lifetimeToValue,
  minLengthError,
  parseMinLength,
  policyToDraft,
  provenanceText,
  readAccessOverrideNote,
  valueToLifetime,
} from './adminAuthModel.js';

const prov = (patch: Partial<SettingProvenance>): SettingProvenance => ({
  source: 'default',
  updated_at: null,
  updated_by_username: null,
  env_vars: [],
  ...patch,
});

describe('provenanceText', () => {
  it('names the admin and the date for an admin-set value', () => {
    expect(provenanceText(prov({ source: 'admin', updated_by_username: 'eric', updated_at: '2026-09-02T12:00:00Z' }))).toBe(
      'Set in admin by eric · Sep 2, 2026',
    );
  });

  it('claims no one and no date the server did not report', () => {
    expect(provenanceText(prov({ source: 'admin', updated_at: '2026-09-02T12:00:00Z' }))).toBe('Set in admin · Sep 2, 2026');
    expect(provenanceText(prov({ source: 'admin' }))).toBe('Set in admin');
  });

  it('names the environment variables, the config file, or the default', () => {
    expect(provenanceText(prov({ source: 'env', env_vars: ['LOGIN_THROTTLE_PER_IP', 'LOGIN_THROTTLE_WINDOW'] }))).toBe(
      'From environment (LOGIN_THROTTLE_PER_IP, LOGIN_THROTTLE_WINDOW)',
    );
    expect(provenanceText(prov({ source: 'env' }))).toBe('From environment');
    expect(provenanceText(prov({ source: 'config' }))).toBe('From knowledge-e3.config');
    expect(provenanceText(prov({}))).toBe('Default');
  });
});

describe('readAccessOverrideNote', () => {
  const read = (provenance: SettingProvenance, deploy: Partial<AuthSettings['read_access']['deploy_default']> = {}): AuthSettings['read_access'] => ({
    read_mode: 'authenticated',
    provenance,
    deploy_default: { ...prov({}), read_mode: 'public', ...deploy },
    editable: true,
  });

  it('is silent when no admin has chosen', () => {
    expect(readAccessOverrideNote(read(prov({ source: 'env', env_vars: ['KNOWLEDGE_E3_DEFAULT_READ_ACCESS'] })))).toBeNull();
  });

  it('says which deploy default an admin choice overrides', () => {
    expect(readAccessOverrideNote(read(prov({ source: 'admin' })))).toBe('Overrides the deploy default (Public, built-in default).');
    expect(
      readAccessOverrideNote(read(prov({ source: 'admin' }), { source: 'env', env_vars: ['KNOWLEDGE_E3_DEFAULT_READ_ACCESS'] })),
    ).toBe('Overrides the deploy default (Public, from environment (KNOWLEDGE_E3_DEFAULT_READ_ACCESS)).');
  });
});

describe('password policy draft', () => {
  const saved = { min_length: 12, require_uppercase: true, require_number: false, require_symbol: false };

  it('keeps the typed text, so clearing the field does not snap it to 1', () => {
    const draft = { ...policyToDraft(saved), min_length: '' };
    expect(draft.min_length).toBe('');
    expect(draftToPolicy(draft)).toBeNull();
    expect(isPolicyDirty(draft, saved)).toBe(true);
  });

  it('parses only whole numbers from 1 to 128', () => {
    expect(parseMinLength('12')).toBe(12);
    expect(parseMinLength(' 8 ')).toBe(8);
    expect(parseMinLength('0')).toBeNull();
    expect(parseMinLength('129')).toBeNull();
    expect(parseMinLength('1.5')).toBeNull();
    expect(parseMinLength('-3')).toBeNull();
    expect(parseMinLength('abc')).toBeNull();
    expect(minLengthError('0')).toBe('Enter a whole number from 1 to 128.');
    expect(minLengthError('128')).toBeNull();
  });

  it('is clean when the draft matches what is saved, including text that parses to it', () => {
    expect(isPolicyDirty(policyToDraft(saved), saved)).toBe(false);
    expect(isPolicyDirty({ ...policyToDraft(saved), min_length: '12 ' }, saved)).toBe(false);
    expect(isPolicyDirty({ ...policyToDraft(saved), min_length: '13' }, saved)).toBe(true);
    expect(isPolicyDirty({ ...policyToDraft(saved), require_symbol: true }, saved)).toBe(true);
  });

  it('saves a valid draft as numbers and booleans', () => {
    expect(draftToPolicy({ ...policyToDraft(saved), min_length: '16', require_number: true })).toEqual({
      min_length: 16,
      require_uppercase: true,
      require_number: true,
      require_symbol: false,
    });
  });
});

describe('token lifetime choices', () => {
  it('offers no maximum and the standard lifetimes', () => {
    expect(lifetimeOptions(null).map((o) => o.value)).toEqual([null, 365, 90, 30]);
    expect(lifetimeOptions(90).map((o) => o.value)).toEqual([null, 365, 90, 30]);
  });

  it('adds a value set outside the page instead of misreporting it', () => {
    const options = lifetimeOptions(180);
    expect(options.map((o) => o.value)).toEqual([null, 365, 180, 90, 30]);
    expect(options.find((o) => o.value === 180)?.label).toBe('180 days');
  });

  it('round-trips null through the select value', () => {
    expect(valueToLifetime(lifetimeToValue(null))).toBeNull();
    expect(valueToLifetime(lifetimeToValue(90))).toBe(90);
  });
});

describe('login throttle text', () => {
  it('says the window as a person would', () => {
    expect(durationText(15 * 60_000)).toBe('15 minutes');
    expect(durationText(3_600_000)).toBe('1 hour');
    expect(durationText(90_000)).toBe('90 seconds');
    expect(durationText(1_500)).toBe('1500 ms');
  });

  it('says Off for a disabled bucket', () => {
    expect(attemptLimitText(5)).toBe('5 failed attempts');
    expect(attemptLimitText(1)).toBe('1 failed attempt');
    expect(attemptLimitText(null)).toBe('Off');
  });
});
