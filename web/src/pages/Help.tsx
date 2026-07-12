import './Help.css';

interface Shortcut {
  keys: string;
  description: string;
}

const SECTIONS: Array<{ title: string; shortcuts: Shortcut[] }> = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: 'Cmd/Ctrl + K', description: 'Open command palette' },
      { keys: 'Cmd/Ctrl + ?', description: 'Open this help section' },
      { keys: 'Cmd/Ctrl + S', description: 'Save page' },
      { keys: 'Esc', description: 'Cancel / close dialog' },
    ],
  },
  {
    title: 'Editor modes',
    shortcuts: [
      { keys: 'Cmd/Ctrl + Shift + M', description: 'Cycle edit mode (Source / Hybrid / WYSIWYG)' },
    ],
  },
  {
    title: 'Formatting (WYSIWYG)',
    shortcuts: [
      { keys: 'Cmd/Ctrl + B', description: 'Bold' },
      { keys: 'Cmd/Ctrl + I', description: 'Italic' },
      { keys: 'Cmd/Ctrl + E', description: 'Inline code' },
      { keys: 'Cmd/Ctrl + `', description: 'Inline code (alternate)' },
      { keys: 'Cmd/Ctrl + 1', description: 'Heading 1' },
      { keys: 'Cmd/Ctrl + 2', description: 'Heading 2' },
      { keys: 'Cmd/Ctrl + 3', description: 'Heading 3' },
      { keys: 'Cmd/Ctrl + 0', description: 'Paragraph' },
      { keys: 'Cmd/Ctrl + Shift + 7', description: 'Numbered list' },
      { keys: 'Cmd/Ctrl + Shift + 8', description: 'Bulleted list' },
      { keys: 'Cmd/Ctrl + Shift + L', description: 'Bulleted list (alternate)' },
      { keys: 'Cmd/Ctrl + Shift + S', description: 'Strikethrough' },
    ],
  },
  {
    title: 'Markdown shortcuts (WYSIWYG / Source / Hybrid)',
    shortcuts: [
      { keys: '**text**', description: 'Bold in Markdown' },
      { keys: '*text*', description: 'Italic in Markdown' },
      { keys: '`code`', description: 'Inline code in Markdown' },
      { keys: '# heading', description: 'Heading shortcut' },
      { keys: '- item', description: 'Bulleted-list shortcut' },
      { keys: '1. item', description: 'Numbered-list shortcut' },
      { keys: '- [ ] task', description: 'Task-list shortcut' },
      { keys: '> quote', description: 'Blockquote shortcut' },
    ],
  },
  {
    title: 'Wiki-links',
    shortcuts: [
      { keys: '[[', description: 'Open page autocomplete (wikilink)' },
    ],
  },
];

export function Help() {
  return (
    <main className="kp-help-page">
      <article className="kp-help-card" aria-labelledby="kbd-help-title">
        <p className="kp-help-eyebrow">Help</p>
        <h1 id="kbd-help-title">Keyboard shortcuts</h1>
        <p className="kp-help-intro">
          These shortcuts are available across the knowledge base and editor. This page replaces the old popup so the reference stays visible while you work.
        </p>

        <div className="kp-help-sections" role="region" aria-label="Keyboard shortcuts">
          {SECTIONS.map((section) => (
            <section key={section.title} className="kp-help-section">
              <h2>{section.title}</h2>
              <dl>
                {section.shortcuts.map((shortcut) => (
                  <div key={`${section.title}-${shortcut.keys}`} className="kp-help-shortcut-row">
                    <dt><kbd>{shortcut.keys}</kbd></dt>
                    <dd>{shortcut.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}
