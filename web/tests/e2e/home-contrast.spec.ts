import { test, expect } from './fixtures.js';
import type { Locator } from '@playwright/test';

/**
 * Legibility of the front page's quiet text, computed in the browser
 * (features/18-home-page.feature; home plan R2.7).
 *
 * Revision 2 made three things on the home page deliberately quieter — the
 * story metadata, the briefs, and the "Powered by" colophon — and Eric's
 * condition on the colophon applies to all three: subtle must not mean
 * illegible. So the claim tested here is WCAG AA, a contrast ratio of at least
 * 4.5:1, measured from `getComputedStyle` on the rendered page in BOTH themes,
 * rather than read out of tokens.css. What is under test is the colour the
 * reader actually gets: the token a rule resolves to, over the background the
 * element actually sits on, after any translucent layers are composited.
 *
 * No new dependency: the WCAG relative-luminance formula is a dozen lines.
 *
 * Eric's second round added the other half of the claim: the metadata line
 * (topic, author, date, type, reading time) must read clearly QUIETER than the
 * brief above it, without dropping below AA. So the metadata is also asserted
 * to resolve to `--kp-text-meta`, to contrast measurably less than the brief,
 * and to be set a size smaller.
 *
 * The theme is chosen the way a reader chooses it — `kp-theme` in localStorage,
 * which the ThemeProvider applies as `data-theme` on <html> — and the context's
 * `colorScheme` is set to match, so `system` could not silently stand in for
 * either. The visitor is anonymous (a fresh context, never the `page` fixture),
 * because that is who the front page is mostly for and because a signed-in
 * user's server-side theme preference would override the choice.
 */

const AA = 4.5;

/**
 * The contrast ratio of an element's own text colour against its effective
 * background. Runs inside the page, so it must be self-contained.
 */
async function contrastOf(locator: Locator): Promise<{ ratio: number; fg: string; bg: string }> {
  return locator.evaluate((el) => {
    type Rgba = [number, number, number, number];

    // Chromium serialises computed colours as `rgb()`/`rgba()`, or as
    // `color(srgb r g b / a)` for values produced by `color-mix()`.
    const parse = (value: string): Rgba => {
      const rgb = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
      if (rgb) {
        const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
        return [parseFloat(rgb[1]!), parseFloat(rgb[2]!), parseFloat(rgb[3]!), alpha];
      }
      const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/);
      if (srgb) {
        const alpha = srgb[4] === undefined ? 1 : srgb[4].endsWith('%') ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4]);
        return [parseFloat(srgb[1]!) * 255, parseFloat(srgb[2]!) * 255, parseFloat(srgb[3]!) * 255, alpha];
      }
      if (value === 'transparent') return [0, 0, 0, 0];
      throw new Error(`unparsed colour: ${value}`);
    };

    // `top` painted over `under`, where `under` is opaque.
    const over = (top: Rgba, under: Rgba): Rgba => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
      1,
    ];

    // The background the text is painted on: every ancestor's background colour
    // from the element outwards, composited from the outside in over the
    // canvas (white, as the browser paints it, if nothing is opaque).
    const layers: Rgba[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor);
      if (layer[3] > 0) layers.push(layer);
      if (layer[3] >= 1) break;
    }
    let bg: Rgba = [255, 255, 255, 1];
    for (const layer of layers.reverse()) bg = over(layer, bg);

    const fg = over(parse(getComputedStyle(el).color), bg);

    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: Rgba) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
    const [light, dark] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
    const fmt = (c: Rgba) => `rgb(${c.slice(0, 3).map((n) => Math.round(n)).join(', ')})`;
    return { ratio: (light + 0.05) / (dark + 0.05), fg: fmt(fg), bg: fmt(bg) };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`the front page's metadata, briefs and colophon meet AA contrast in the ${theme} theme`, async ({ browser, signedInPage }) => {
    const ctx = await browser.newContext({ baseURL: new URL(signedInPage.url()).origin, colorScheme: theme });
    await ctx.addInitScript((mode) => {
      try {
        window.localStorage.setItem('kp-theme', mode);
      } catch {
        // A context without storage cannot pick a theme; the attribute check
        // below then fails loudly instead of measuring the wrong palette.
      }
    }, theme);
    try {
      const anon = await ctx.newPage();
      await anon.goto('/');
      await expect(anon.locator('html')).toHaveAttribute('data-theme', theme);

      const home = anon.locator('main.Home');
      await expect(home.getByTestId('home-lead')).toBeVisible();

      // The quiet text on the page, each by the class that styles it. Every one
      // must be present — a target that silently vanished would pass by
      // measuring nothing.
      const targets: Record<string, Locator> = {
        'lead story metadata': home.locator('.Home__lead .kp-item-meta').first(),
        'row metadata': home.locator('.Home__row .kp-item-meta').first(),
        'row brief': home.locator('.Home__row .kp-item-row__preview').first(),
        'lead story brief': home.locator('.Home__lead .kp-item-card__preview').first(),
        colophon: home.locator('.SiteFooter').first(),
      };

      const ratios: Record<string, number> = {};
      for (const [name, locator] of Object.entries(targets)) {
        await expect(locator, `${name} must be on the page to be measured`).toBeVisible();
        const { ratio, fg, bg } = await contrastOf(locator);
        ratios[name] = ratio;
        expect(ratio, `${name} in the ${theme} theme: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
      }

      // Quieter than the brief, visibly: the metadata resolves to its own token
      // (not the brief's `--kp-text-secondary`), contrasts at most 90% as much
      // as the brief it sits under — tokens.css has ~82% in light, ~69% in dark
      // — and is a type step smaller.
      for (const [meta, brief] of [
        ['row metadata', 'row brief'],
        ['lead story metadata', 'lead story brief'],
      ] as const) {
        const usesMetaToken = await targets[meta]!.evaluate((el) => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--kp-text-meta)';
          el.appendChild(probe);
          const expected = getComputedStyle(probe).color;
          probe.remove();
          const token = getComputedStyle(document.documentElement).getPropertyValue('--kp-text-meta').trim();
          return token !== '' && getComputedStyle(el).color === expected;
        });
        expect(usesMetaToken, `${meta} must be coloured by --kp-text-meta in the ${theme} theme`).toBe(true);
        expect(
          ratios[meta]!,
          `${meta} (${ratios[meta]!.toFixed(2)}:1) must be visibly quieter than the ${brief} (${ratios[brief]!.toFixed(2)}:1) in the ${theme} theme`,
        ).toBeLessThanOrEqual(ratios[brief]! * 0.9);
        const [metaSize, briefSize] = await Promise.all(
          [targets[meta]!, targets[brief]!].map((l) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))),
        );
        expect(metaSize, `${meta} must be set smaller than the ${brief}`).toBeLessThan(briefSize!);
      }

      // Quieter, and still unmistakably there: no rule above the colophon,
      // centred, the text unchanged (R2.7). Width, not style: a global reset
      // leaves every element `border-style: solid` at zero width.
      const footer = home.locator('.SiteFooter');
      await expect(footer).toHaveCSS('border-top-width', '0px');
      await expect(footer).toHaveCSS('justify-content', 'center');
      await expect(footer).toContainText('Powered by Knowledge × 10');
      await expect(footer.locator('sup')).toHaveText('3');
    } finally {
      await ctx.close();
    }
  });
}
