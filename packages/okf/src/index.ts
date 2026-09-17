/**
 * @echozedlabs/okf — exchange Knowledge E3 content in the Open Knowledge Format (OKF) v0.2.
 *
 * See the OKF format study, the OKF v0.1→v0.2 migration notes, and the LLM wiki
 * study's phased git-of-record plan that this is an increment of.
 */
export { buildBundle, renderBundleIndex, type BundleIndexEntry } from './bundle.js';
export { pageToConcept, conceptPathForSlug, renderConcept } from './concept.js';
export { translateLinks, resolveBundleLinks, type LinkResolver } from './links.js';
export { validateBundle } from './conformance.js';
export {
  humanActor,
  processActor,
  agentActor,
  isHumanActor,
  parseActor,
  e3OwnerToActor,
  type ActorKind,
  type ParsedActor,
} from './actor.js';
export { normalizeLifecycle, deriveLifecycle, isStale, isDeprecatedReviewStatus } from './lifecycle.js';
export {
  ATTESTED_COMPUTATION_TYPE,
  isAttestedComputation,
  hasComputationSection,
  readAttestedContract,
  validateAttestedComputation,
  classifyPathValue,
  type AttestedContract,
  type AttestedReadiness,
  type PathValueKind,
} from './attested.js';
export {
  trustTier,
  latestVerifiedAt,
  normalizeVerified,
  freshness,
  okfSignals,
  type Freshness,
  type OkfSignals,
} from './trust.js';
export {
  auditBundle,
  summarizeBundleSignals,
  type AuditReport,
  type AuditOptions,
  type SignalSummary,
} from './audit.js';
export {
  extractClaims,
  sourceIdsOf,
  scoreClaimHealth,
  citationGrounding,
  type Claim,
  type ClaimStatus,
  type ClaimGrounding,
  type ClaimHealth,
  type ClaimHealthOptions,
} from './claims.js';
export {
  REPAIR_PREFIX,
  repairMarker,
  repairBrokenLinks,
  downgradeInvalidMermaid,
  extractRepairMarkers,
  stripRepairMarkers,
  isContentUnchanged,
  type RepairResult,
} from './repair.js';
export {
  restoreWikiLinks,
  conceptToImport,
  parseBundleFiles,
  parseBundleAssets,
  parseBundleIndex,
  type ImportedAsset,
  type BundleIndexInfo,
} from './import.js';
export type {
  OkfFrontmatter,
  OkfActor,
  OkfActorEvent,
  OkfTrustTier,
  OkfLifecycle,
  OkfSource,
  OkfUsageWindow,
  OkfParameter,
  OkfExecutor,
  OkfAttester,
  PageInput,
  LinkStyle,
  ConceptResult,
  BundleFile,
  BundleAsset,
  OkfBundle,
  ConformanceIssue,
  ConformanceReport,
  BundleLinkIssue,
  BuildOptions,
  BundleLink,
  OkfImportItem,
} from './types.js';
