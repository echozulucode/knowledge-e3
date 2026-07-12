/**
 * Redaction utility for audit payloads.
 *
 * Strips sensitive keys recursively and truncates large strings.
 * Used by AuditService.record() before serializing the payload.
 */

// List of case-insensitive substrings; any key whose lowercase form contains
// one of these is redacted. Substring (rather than exact) matching catches
// `db_password`, `csrf_token`, `oauth_secret`, etc. — the cost is occasional
// false positives, but for an audit log "leak nothing" beats "leak rarely".
const REDACT_SUBSTRINGS = [
  'password',
  'token',
  'secret',
  'authorization',
  'cookie',
];

const MAX_STRING_LENGTH = 4096;
const TRUNCATION_SUFFIX = '...<truncated>';

function shouldRedact(key: string): boolean {
  const lower = key.toLowerCase();
  for (const needle of REDACT_SUBSTRINGS) {
    if (lower.includes(needle)) return true;
  }
  return false;
}

/**
 * Recursively redact sensitive data from an object.
 * Returns a new object with sensitive fields stripped or truncated.
 */
export function redact(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Truncate long strings.
    if (obj.length > MAX_STRING_LENGTH) {
      const original = obj;
      return `${original.substring(0, MAX_STRING_LENGTH)}${TRUNCATION_SUFFIX}, original ${original.length} chars>`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redact(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (shouldRedact(key)) {
        // Skip this key.
        continue;
      }
      result[key] = redact(value);
    }
    return result;
  }

  // Return primitives (numbers, booleans) as-is.
  return obj;
}
