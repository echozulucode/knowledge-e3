/**
 * IconPicker — choose a topic icon from the closed `PIN_ICONS` list
 * (the admin UX review §3.2, §4.2).
 *
 * The old editor was a `<select>` of camelCase tokens with the glyph previewed
 * beside it, because an `<option>` cannot draw one. Here the glyphs ARE the
 * choices: a native radio grid (arrow keys and one tab stop for free), each
 * radio named by the icon's human name (`iconName`), with the same name shown
 * as a visible tooltip on hover and keyboard focus — an icon alone is not a
 * label anyone can be expected to read.
 */
import { useId } from 'react';
import { PIN_ICONS } from '@echozedlabs/ui';
import { TopicIcon } from '../../features/home/topicIcons.js';
import { iconName, knownToken } from './choicePickerModel.js';
import './SwatchPicker.css';
import './IconPicker.css';

export interface IconPickerProps {
  legend: string;
  value: string | null | undefined;
  onChange: (token: string) => void;
  allowNone?: boolean;
  disabled?: boolean;
  helper?: string;
  name?: string;
}

export function IconPicker({ legend, value, onChange, allowNone = true, disabled, helper, name }: IconPickerProps): JSX.Element {
  const generated = useId();
  const groupName = name ?? `icon-${generated}`;
  const helperId = `${groupName}-helper`;
  const current = knownToken(value, PIN_ICONS);
  const tokens: string[] = [...(allowNone ? [''] : []), ...PIN_ICONS];

  return (
    <fieldset className="kp-swatches kp-icons" disabled={disabled} aria-describedby={helper ? helperId : undefined}>
      <legend className="kp-swatches__legend">{legend}</legend>
      <div className="kp-icons__grid">
        {tokens.map((token) => {
          const label = token ? iconName(token) : 'None';
          return (
            <label key={token || 'none'} className="kp-iconChoice" data-none={!token || undefined}>
              <input
                type="radio"
                className="kp-iconChoice__input"
                name={groupName}
                value={token}
                checked={current === token}
                onChange={() => onChange(token)}
                aria-label={label}
              />
              <span className="kp-iconChoice__glyph" aria-hidden="true">
                {token ? <TopicIcon token={token} /> : '∅'}
              </span>
              <span className="kp-iconChoice__tip" aria-hidden="true">
                {label}
              </span>
            </label>
          );
        })}
      </div>
      {helper ? (
        <p id={helperId} className="kp-swatches__helper">
          {helper}
        </p>
      ) : null}
    </fieldset>
  );
}
