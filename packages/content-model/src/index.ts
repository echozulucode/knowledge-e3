/**
 * @echozedlabs/content-model — registry, schemas, templates, lint, display state.
 * See the knowledge hub plan §6 and §9.
 */
export {
  CONTENT_TYPES,
  listContentTypes,
  slugifyType,
  findContentType,
  canonicalTypeLabel,
  type ContentTypeField,
  type ContentTypeDef,
} from './registry.js';
export { reviewHorizonDays, deriveDisplayState, type DerivedDisplayState } from './lifecycle.js';
export { schemaFor, templateFor, type SchemaField } from './schema.js';
export { lint, type LintOptions } from './lint.js';
export { validateOkfBundle, bundleSummaryLine, type BundleValidationOptions } from './bundle-validation.js';
export { suggestMetadata, type SuggestInput, type MetadataSuggestion } from './suggest.js';
