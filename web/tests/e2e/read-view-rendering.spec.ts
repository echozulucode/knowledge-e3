import { test, expect, createPageViaApi } from './fixtures.js';
import type { Page } from '@playwright/test';

/**
 * One renderer on the read page (reader UX plan R1.1).
 *
 * The defect these cover: an author drew a diagram and the published page every
 * reader sees showed a grey code fence, because `ReadView` was react-markdown
 * and nothing else while the editor's Preview rendered through
 * `@echozedlabs/renderers`. The reader's surface is not allowed to be the
 * weaker one, so the read page now delegates diagrams, highlighting and
 * callouts to those same renderers.
 *
 * Each assertion is about what a READER can see, not about which library drew
 * it — except where the class name is the contract between the renderer and the
 * page's stylesheet.
 */
/**
 * Where the article column sits inside the page body, and what 128ch of body
 * text measures in this browser's font. The gaps are taken against the body's
 * CLIENT box, so a classic scrollbar on the body (it scrolls at >=1180px) is
 * not counted as gutter on one side only.
 */
async function articleColumnGeometry(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.kp-pageview-body')!;
    const column = document.querySelector<HTMLElement>('.kp-article-reader')!;
    const text = document.querySelector<HTMLElement>('.kp-read-view')!;
    const b = body.getBoundingClientRect();
    const c = column.getBoundingClientRect();
    const innerLeft = b.left + body.clientLeft;
    const innerRight = innerLeft + body.clientWidth;
    // `ch` is font-relative, so measure it where the prose is: a hidden probe
    // inside the read view inherits its font family and size.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:128ch;height:0;';
    text.appendChild(probe);
    const width128ch = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      leftGap: c.left - innerLeft,
      rightGap: innerRight - c.right,
      columnWidth: c.width,
      columnMaxWidth: parseFloat(getComputedStyle(column).maxWidth),
      bodyInnerWidth: body.clientWidth,
      width128ch,
    };
  });
}

test.describe('read page rendering', () => {
  test('renders a mermaid diagram, highlighted code and a callout', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const body = [
      '```mermaid',
      'graph TD;',
      '  Author-->Reader;',
      '```',
      '',
      '```ts',
      'const shipped: string = "yes";',
      '```',
      '',
      '> [!NOTE] Read me first',
      '> The callout body.',
      '',
      '```',
      'plain fence, no language',
      '```',
    ].join('\n');
    const page = await createPageViaApi(apiAsAdmin, {
      title: `Rendered Item ${suffix}`,
      body,
      status: 'published',
      frontmatter: { type: 'how-to' },
    });

    await signedInPage.goto(`/p/${page.slug}`);
    const article = signedInPage.locator('.kp-read-view');

    // 1. The diagram is a diagram. Mermaid draws the node labels as SVG <text>,
    //    so the reader can actually read the graph, not just see a picture.
    const diagram = article.locator('.kp-rv-figure svg');
    await expect(diagram).toBeVisible({ timeout: 20_000 });
    await expect(article.locator('.kp-rv-figure')).toContainText('Reader');

    // 2. The TypeScript fence is highlighted: shiki wraps each token in a span
    //    carrying its own colour, which a plain <pre> never has.
    const highlighted = article.locator('.kp-rv-highlight pre code span[style*="color"]').first();
    await expect(highlighted).toBeVisible({ timeout: 20_000 });
    await expect(article.locator('.kp-rv-highlight')).toContainText('const shipped');

    // 3. The callout is an aside with its title, not a quoted `[!NOTE]` line.
    const callout = article.locator('aside.me-renderer-callout');
    await expect(callout).toBeVisible();
    await expect(callout).toContainText('Read me first');
    await expect(callout).toContainText('The callout body.');
    await expect(article).not.toContainText('[!NOTE]');

    // 4. An untagged fence stays a plain code block — no highlighter is loaded
    //    for it, and it must still be readable.
    await expect(article.locator('pre.kp-rv-code-block')).toContainText('plain fence, no language');
  });

  test('a malformed diagram degrades to its source, and the page still reads', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const body = [
      'Before the diagram.',
      '',
      '```mermaid',
      'graph TD;;;  <-- not a diagram at all',
      '   ][',
      '```',
      '',
      'After the diagram.',
    ].join('\n');
    const page = await createPageViaApi(apiAsAdmin, {
      title: `Broken Diagram ${suffix}`,
      body,
      status: 'published',
      frontmatter: { type: 'how-to' },
    });

    await signedInPage.goto(`/p/${page.slug}`);
    const article = signedInPage.locator('.kp-read-view');

    // The prose around it renders, the diagram source is still readable as the
    // fence the author wrote, and no renderer error text reaches the reader.
    await expect(article).toContainText('Before the diagram.');
    await expect(article).toContainText('After the diagram.');
    await expect(article.locator('pre[data-language="mermaid"]')).toContainText('not a diagram at all');
    await expect(article.locator('.kp-rv-figure')).toHaveCount(0);
    await expect(article).not.toContainText(/renderer .* failed/i);
  });

  test('a page with no diagram and no code fence renders as plain prose', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    // The cheap path: nothing here may pull in a renderer, and the prose
    // constructs react-markdown + remark-gfm handle (nested lists, plain
    // blockquotes, tables, rules) must all survive the change.
    const body = [
      '# Section',
      '',
      '- outer item',
      '  - nested item',
      '',
      '> An ordinary quotation, not a callout.',
      '',
      '| Column | Value |',
      '| --- | --- |',
      '| a | 1 |',
      '',
      '---',
      '',
      'Tail paragraph with `inline code`.',
    ].join('\n');
    const page = await createPageViaApi(apiAsAdmin, {
      title: `Plain Prose ${suffix}`,
      body,
      status: 'published',
      frontmatter: { type: 'how-to' },
    });

    // The cost claim, asserted rather than asserted-in-a-comment: a page with
    // no diagram and no language-tagged fence must not fetch the renderer
    // chunks at all (mermaid alone is ~600 kB).
    const rendererRequests: string[] = [];
    signedInPage.on('request', (request) => {
      if (/mermaid|rendererKit|shiki/i.test(request.url())) rendererRequests.push(request.url());
    });

    await signedInPage.goto(`/p/${page.slug}`);
    const article = signedInPage.locator('.kp-read-view');

    await expect(article.locator('ul ul li')).toContainText('nested item');
    await expect(article.locator('blockquote')).toContainText('An ordinary quotation');
    await expect(article.locator('aside.me-renderer-callout')).toHaveCount(0);
    await expect(article.locator('table td').first()).toContainText('a');
    await expect(article.locator('hr')).toHaveCount(1);
    await expect(article.locator('code.kp-rv-inline-code')).toContainText('inline code');
    expect(rendererRequests).toEqual([]);
  });

  test('the article column is centred beside the context pane and capped at 128ch of body text', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    // Owner decision 2026-09-13: centred, not left-aligned, and ~10% wider
    // (116ch -> 128ch) so technical content wraps less.
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const longLine = 'A deliberately long paragraph of technical prose that must wrap inside the reading column. '.repeat(12);
    const page = await createPageViaApi(apiAsAdmin, {
      title: `Centred Column ${suffix}`,
      body: ['## Section', '', longLine].join('\n'),
      status: 'published',
      frontmatter: { type: 'how-to' },
    });

    await signedInPage.setViewportSize({ width: 1440, height: 900 });
    await signedInPage.goto(`/p/${page.slug}`);
    await expect(signedInPage.locator('.kp-read-view')).toContainText('deliberately long paragraph');
    await expect(signedInPage.locator('.kp-pageview-rail')).toBeVisible();

    const expectCentredAndCapped = async (label: string) => {
      // The rail's open/collapse is a grid-column transition; poll until settled.
      await expect
        .poll(async () => {
          const g = await articleColumnGeometry(signedInPage);
          return Math.abs(g.leftGap - g.rightGap);
        }, { message: `centred at ${label}` })
        .toBeLessThanOrEqual(2);
      const g = await articleColumnGeometry(signedInPage);
      // The cap is 128ch of the body text's font, and the column is exactly
      // that wide whenever the body has room for it.
      expect(Math.abs(g.columnMaxWidth - g.width128ch), `max width is 128ch at ${label}`).toBeLessThanOrEqual(2);
      expect(Math.abs(g.columnWidth - Math.min(g.bodyInnerWidth, g.width128ch)), `column width at ${label}`).toBeLessThanOrEqual(2);
      expect(g.leftGap, `no negative gutter at ${label}`).toBeGreaterThanOrEqual(-1);
      return g;
    };

    // 1440px with the context pane open.
    await expectCentredAndCapped('1440px, pane open');

    // Collapsed to its 44px strip, the article reclaims the space and stays centred.
    await signedInPage.getByRole('button', { name: 'Collapse context pane' }).click();
    await expect(signedInPage.getByRole('button', { name: 'Expand context pane' })).toBeVisible();
    await expectCentredAndCapped('1440px, pane collapsed');
    await signedInPage.getByRole('button', { name: 'Expand context pane' }).click();

    // Wide enough that the measure, not the body, sets the width: real gutters, equal.
    await signedInPage.setViewportSize({ width: 1920, height: 1000 });
    const wide = await expectCentredAndCapped('1920px, pane open');
    expect(wide.leftGap, 'a visible gutter either side at 1920px').toBeGreaterThan(8);

    // Stacked below 1180px, the pane sits under the article; still centred.
    await signedInPage.setViewportSize({ width: 1024, height: 800 });
    await expectCentredAndCapped('1024px, stacked');
  });

  test('wide tables and code scroll inside their own box, never the page', async ({ signedInPage, apiAsAdmin }, testInfo) => {
    const suffix = `${testInfo.workerIndex}-${Date.now()}`;
    const columns = Array.from({ length: 24 }, (_, i) => `Column_${i}_with_a_long_header`);
    const body = [
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      `| ${columns.map((c) => `${c}_value`).join(' | ')} |`,
      '',
      '```',
      `kubectl get pods --all-namespaces ${'--selector=app.kubernetes.io/name=really-long-value '.repeat(8)}`,
      '```',
      '',
      `A path with no break opportunities: ${'/very/long/unbroken/path'.repeat(30)}`,
    ].join('\n');
    const page = await createPageViaApi(apiAsAdmin, {
      title: `Wide Elements ${suffix}`,
      body,
      status: 'published',
      frontmatter: { type: 'how-to' },
    });

    await signedInPage.setViewportSize({ width: 1440, height: 900 });
    await signedInPage.goto(`/p/${page.slug}`);
    const article = signedInPage.locator('.kp-read-view');
    await expect(article.locator('.kp-rv-table-wrap table')).toBeVisible();
    await expect(article.locator('pre.kp-rv-code-block')).toBeVisible();

    const boxes = await signedInPage.evaluate(() => {
      const column = document.querySelector<HTMLElement>('.kp-article-reader')!.getBoundingClientRect();
      const measure = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector)!;
        const r = el.getBoundingClientRect();
        return { scrolls: el.scrollWidth > el.clientWidth, overflowX: getComputedStyle(el).overflowX, left: r.left, right: r.right };
      };
      const body = document.querySelector<HTMLElement>('.kp-pageview-body')!;
      return {
        column: { left: column.left, right: column.right },
        table: measure('.kp-rv-table-wrap'),
        code: measure('pre.kp-rv-code-block'),
        bodyOverflowX: body.scrollWidth - body.clientWidth,
      };
    });

    for (const [name, box] of [['table', boxes.table], ['code', boxes.code]] as const) {
      expect(box.overflowX, `${name} is its own horizontal scroller`).toBe('auto');
      expect(box.scrolls, `${name} content is wider than its box`).toBe(true);
      expect(box.left, `${name} starts inside the column`).toBeGreaterThanOrEqual(boxes.column.left - 1);
      expect(box.right, `${name} ends inside the column`).toBeLessThanOrEqual(boxes.column.right + 1);
    }
    // Nothing — the unbroken path included — is wider than the page body.
    expect(boxes.bodyOverflowX).toBeLessThanOrEqual(1);
  });
});
