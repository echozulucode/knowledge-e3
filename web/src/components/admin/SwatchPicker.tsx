/**
 * SwatchPicker — choose a pin colour from the fixed palette
 * (the admin UX review §3.2, §4.2).
 *
 * A native radio group, so arrow keys, Space and the group's single tab stop
 * come from the browser rather than from code here. Every swatch carries the
 * colour's NAME as visible text: the palette exists so a colour is recognition,
 * never the only signal (PinnedTopicCard's rule), and the picker holds itself
 * to the same standard. "None" is a real choice — the card then uses the
 * neutral border colour.
 */
import { useId } from 'react';
import { PIN_COLORS } from '@echozedlabs/ui';
import { colorName, knownToken } from './choicePickerModel.js';
import './SwatchPicker.css';

export interface SwatchPickerProps {
  /** Legend text (visible). */
  legend: string;
  value: string | null | undefined;
  onChange: (token: string) => void;
  /** Include a "None" swatch. Default true. */
  allowNone?: boolean;
  disabled?: boolean;
  helper?: string;
  /** Radio `name`; generated when omitted. */
  name?: string;
}

export function SwatchPicker({ legend, value, onChange, allowNone = true, disabled, helper, name }: SwatchPickerProps): JSX.Element {
  const generated = useId();
  const groupName = name ?? `swatch-${generated}`;
  const helperId = `${groupName}-helper`;
  const current = knownToken(value, PIN_COLORS);
  const tokens: string[] = [...(allowNone ? [''] : []), ...PIN_COLORS];

  return (
    <fieldset className="kp-swatches" disabled={disabled} aria-describedby={helper ? helperId : undefined}>
      <legend className="kp-swatches__legend">{legend}</legend>
      <div className="kp-swatches__row">
        {tokens.map((token) => (
          <label key={token || 'none'} className="kp-swatch" data-color={token || undefined}>
            <input
              type="radio"
              className="kp-swatch__input"
              name={groupName}
              value={token}
              checked={current === token}
              onChange={() => onChange(token)}
            />
            <span className="kp-swatch__dot" aria-hidden="true" style={token ? { ['--kp-swatch' as string]: `var(--kp-pin-${token})` } : undefined} />
            <span className="kp-swatch__name">{token ? colorName(token) : 'None'}</span>
          </label>
        ))}
      </div>
      {helper ? (
        <p id={helperId} className="kp-swatches__helper">
          {helper}
        </p>
      ) : null}
    </fieldset>
  );
}
