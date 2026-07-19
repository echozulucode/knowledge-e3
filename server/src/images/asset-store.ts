import type { AssetDescriptor } from './asset-descriptor.js';

/**
 * The open-core storage seam for asset bytes (ADR-0003).
 *
 * The core depends only on this contract, never on a concrete backend. Bytes are
 * content-addressed, so `file` (a `<sha16>.<ext>` name) is the put-by-digest key.
 * `LocalFsAssetStore` (AssetsService) is the open, self-hosted default; the cloud
 * edition supplies an Azure Blob adapter, and an S3-compatible adapter is the
 * portable option — each behind this same interface. `capabilities` lets the
 * core adapt (e.g. use presigned delivery when the backend offers it) without
 * knowing which backend is active.
 *
 * `readDescriptors(dir)` is intrinsically filesystem-shaped — it reads a git
 * working tree that was cloned to disk for a rebuild — so it takes an optional
 * directory. Object-store backends can implement it over their own listing.
 */
export interface AssetStoreCapabilities {
  /** Backend can hand out short-lived direct download URLs (e.g. SAS/presigned). */
  presignedDelivery: boolean;
  /** Backend can copy an object without round-tripping bytes through the app. */
  serverSideCopy: boolean;
}

export interface AssetStore {
  readonly capabilities: AssetStoreCapabilities;

  /** Store bytes under the content-addressed name `file`. */
  write(file: string, bytes: Buffer): void | Promise<void>;
  /** Read bytes, or null if absent. */
  read(file: string): Buffer | null | Promise<Buffer | null>;
  exists(file: string): boolean | Promise<boolean>;
  /** Remove the bytes and their sidecar descriptor. */
  remove(file: string): void | Promise<void>;
  /** Content-addressed asset filenames (descriptor sidecars excluded). */
  list(): string[] | Promise<string[]>;

  /** Persist the git-tracked sidecar descriptor for an asset. */
  writeDescriptor(descriptor: AssetDescriptor): void | Promise<void>;
  /** All descriptors under `dir` (defaults to the store's own location). */
  readDescriptors(dir?: string): AssetDescriptor[] | Promise<AssetDescriptor[]>;
}
