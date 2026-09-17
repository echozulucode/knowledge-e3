/**
 * Names for the closed visual vocabularies the Swatch and Icon pickers offer.
 *
 * Both lists are tokens (`PIN_COLORS`, `PIN_ICONS`) whose spelling is an API
 * contract — `bookOpen` is an `appIcons` key, and the server drops anything
 * else. People should not have to read camelCase to pick one, so the picker
 * shows a name derived from the token and stores the token itself.
 */

/** `teal` → `Teal`. */
export function colorName(token: string): string {
  return token ? token.charAt(0).toUpperCase() + token.slice(1) : token;
}

/** `diagramProject` → `Diagram project`; `boltLightning` → `Bolt lightning`. */
export function iconName(token: string): string {
  const words = token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : words;
}

/** A stored token outside the list (a stale config) is shown as "none chosen", never as a broken choice. */
export function knownToken(value: string | null | undefined, tokens: readonly string[]): string {
  return value && tokens.includes(value) ? value : '';
}
