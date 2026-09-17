/**
 * FormField — one labelled control with helper and error text
 * (the admin UX review §3.2). Label above, control, helper, error.
 *
 * Use it for every admin form control, in a dialog, a sheet or an edit page.
 * Copy rule (§3.3): explanation lives in `helper` under the field, not in
 * paragraphs above the form or in the page header.
 *
 * Id convention (so the control can describe itself):
 *   control id      = `htmlFor`
 *   helper id       = `${htmlFor}-helper`
 *   error id        = `${htmlFor}-error`
 * The control should set `aria-describedby` to the ids that are present and
 * `aria-invalid` when there is an error. Either do that by hand with
 * `formFieldDescribedBy(htmlFor, { helper, error })`, or pass `children` as a
 * render function and spread what it receives:
 *
 *   <FormField label="Name" htmlFor="section-name" required error={errors.name}>
 *     {(control) => <input {...control} value={name} onChange={…} />}
 *   </FormField>
 *
 * The error gets role="alert" only when it APPEARS after the field mounted
 * (e.g. on blur or on a failed save), so it is announced once; an error that is
 * already present on first render is not shouted, and re-renders do not repeat
 * it. A page with several errors should also show EditPageLayout's
 * `errorSummary`, which is the single announcement for a failed save.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import './FormField.css';

export interface FormFieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  'aria-required': true | undefined;
}

export interface FormFieldProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  helper?: ReactNode;
  error?: string | null;
  /** The control, or a render function receiving the id/aria props to spread onto it. */
  children: ReactNode | ((control: FormFieldControlProps) => ReactNode);
  /** Keep the label for assistive tech but hide it visually (e.g. a search box with a visible placeholder and icon). */
  labelHidden?: boolean;
  /** Short muted hint after the label, e.g. "(1–50)". */
  labelHint?: ReactNode;
}

export const formFieldHelperId = (htmlFor: string): string => `${htmlFor}-helper`;
export const formFieldErrorId = (htmlFor: string): string => `${htmlFor}-error`;

/** The aria-describedby value for a control, error first so it is read first. */
export function formFieldDescribedBy(htmlFor: string, parts: { helper?: unknown; error?: string | null }): string | undefined {
  const ids = [parts.error ? formFieldErrorId(htmlFor) : null, parts.helper ? formFieldHelperId(htmlFor) : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export function FormField({ label, htmlFor, required = false, helper, error, children, labelHidden = false, labelHint }: FormFieldProps): JSX.Element {
  // role="alert" only for an error that appears after mount. Refs, not state:
  // flipping the role must not cost an extra render, and the decision is
  // idempotent across StrictMode's double render (refs are written in effects).
  const mountedRef = useRef(false);
  const previousErrorRef = useRef<string | null | undefined>(error);
  const liveRef = useRef(false);
  if (!error) liveRef.current = false;
  else if (mountedRef.current && !previousErrorRef.current) liveRef.current = true;

  useEffect(() => {
    mountedRef.current = true;
    previousErrorRef.current = error;
  });

  const control: FormFieldControlProps = {
    id: htmlFor,
    'aria-describedby': formFieldDescribedBy(htmlFor, { helper, error }),
    'aria-invalid': error ? true : undefined,
    'aria-required': required ? true : undefined,
  };

  return (
    <div className="kp-field" data-invalid={error ? 'true' : undefined}>
      <label htmlFor={htmlFor} className={labelHidden ? 'kp-field__label kp-field__label--hidden' : 'kp-field__label'}>
        {label}
        {required ? (
          <span className="kp-field__required">
            <span aria-hidden="true"> *</span>
            <span className="kp-field__vh"> (required)</span>
          </span>
        ) : null}
        {labelHint ? <span className="kp-field__hint"> {labelHint}</span> : null}
      </label>
      <div className="kp-field__control">{typeof children === 'function' ? children(control) : children}</div>
      {helper ? (
        <div id={formFieldHelperId(htmlFor)} className="kp-field__helper">
          {helper}
        </div>
      ) : null}
      {error ? (
        <p id={formFieldErrorId(htmlFor)} className="kp-field__error" role={liveRef.current ? 'alert' : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="7" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
