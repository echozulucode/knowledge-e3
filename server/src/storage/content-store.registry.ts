import { mkdirSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import { LocalBundleStore } from '@echozedlabs/content-store';

/** One `LocalBundleStore` per repository working tree, created on first use. */
@Injectable()
export class ContentStoreRegistry {
  private readonly stores = new Map<string, LocalBundleStore>();

  forRepo(repoDir: string): LocalBundleStore {
    let store = this.stores.get(repoDir);
    if (!store) {
      mkdirSync(repoDir, { recursive: true });
      store = new LocalBundleStore(repoDir);
      this.stores.set(repoDir, store);
    }
    return store;
  }
}
