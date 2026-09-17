/**
 * FormSection — a titled group of FormFields (the admin UX review §3.2).
 *
 * Use it to break an edit page or sheet into the questions an admin is
 * answering ("Basics", "What it shows", "Where & how much") instead of one long
 * column. A dialog (≤ ~5 fields) usually needs no sections at all.
 *
 * `tone="danger"` is the danger zone at the end of an edit page (delete,
 * archive): visually separated so a destructive action is never next to Save.
 * The action itself still goes through ConfirmDialog (§3.3).
 *
 * Renders role="group" named by an <h2> (right under an edit page's <h1>).
 * A group, not a named <section>: named sections become region landmarks, and
 * a page of five landmarks per form is noise. Headings still let screen-reader
 * users jump between groups, and the group name is announced on entry.
 */
import { useId, type ReactNode } from 'react';
import './FormSection.css';

export interface FormSectionProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  tone?: 'default' | 'danger';
  /** Right-aligned note next to the title, e.g. "Filters combine". */
  aside?: ReactNode;
}

export function FormSection({ title, description, children, tone = 'default', aside }: FormSectionProps): JSX.Element {
  const titleId = useId();
  return (
    <div role="group" className="kp-form-section" data-tone={tone} aria-labelledby={titleId}>
      <div className="kp-form-section__head">
        <h2 id={titleId} className="kp-form-section__title">
          {title}
        </h2>
        {aside ? <div className="kp-form-section__aside">{aside}</div> : null}
      </div>
      {description ? <div className="kp-form-section__description">{description}</div> : null}
      <div className="kp-form-section__fields">{children}</div>
    </div>
  );
}
