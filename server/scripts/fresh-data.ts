/**
 * Wipe the dev data directory — the SQLite DB *and* the git-of-record mirror
 * (`data/wiki`, `data/topics`) — for a truly fresh, empty instance.
 *
 * Stop the dev server first: it holds an open handle on the SQLite file while
 * running, which prevents deletion (especially on Windows).
 *
 *   pnpm --filter @echozedlabs/server data:fresh
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), 'data');

if (!existsSync(dir)) {
  // eslint-disable-next-line no-console
  console.log(`[fresh] ${dir} does not exist — already clean.`);
} else {
  try {
    rmSync(dir, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`[fresh] removed ${dir} — the next dev run starts empty.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[fresh] could not remove ${dir} — stop the dev server first, then retry.\n${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }
}
