// The content-type registry now lives in `@echozedlabs/content-model`
// (packages/content-model/src/registry.ts). This shim keeps existing imports stable.
export {
  CONTENT_TYPES,
  listContentTypes,
  slugifyType,
  findContentType,
  canonicalTypeLabel,
  type ContentTypeField,
  type ContentTypeDef,
} from '@echozedlabs/content-model';
