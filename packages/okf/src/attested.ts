/**
 * OKF v0.2 Attested Computation support (spec §10).
 *
 * An Attested Computation concept (`type: Attested Computation`) carries a
 * *sanctioned* way to compute a value — a `runtime`, typed `parameters`, the
 * `computation` itself (inline `# Computation` fence or a file), an `executor`
 * (how to run it + the receipt it must return), and an `attester` (deterministic
 * code that checks a receipt). This module reads and *validates* that contract; it
 * NEVER executes anything. The runtime protocol (receipts, verdicts, the attester
 * ABI) is deliberately deferred by the spec (§12), so E3 emits and passes the
 * contract through and checks only its shape — parameter/receipt *names*, never
 * values (spec §10.3: the agent may supply values but MUST NOT author the
 * computation).
 */
import type {
  ConformanceIssue,
  OkfAttester,
  OkfExecutor,
  OkfFrontmatter,
  OkfParameter,
} from './types.js';

/** The canonical type value for an attested computation concept. */
export const ATTESTED_COMPUTATION_TYPE = 'Attested Computation';

/** The parsed contract of an Attested Computation concept. */
export interface AttestedContract {
  runtime?: string;
  parameters: OkfParameter[];
  /** Path to the computation file, when the computation is provided by file. */
  computation?: string;
  executor?: OkfExecutor;
  attester?: OkfAttester;
}

/**
 * Readiness of an attested computation, reported separately (mirrors okf-mcp).
 * These are advisory signals, not conformance failures.
 */
export interface AttestedReadiness {
  /** Has a `runtime` and a computation (inline body fence OR a `computation` file). */
  structuralReady: boolean;
  /** Names the referenced files (`computation`, `executor.resource`, `attester.resource`). */
  assetsReferenced: boolean;
  /** Has an `attester` and a receipt shape — the pieces a consumer needs to attest. */
  attestationReady: boolean;
}

/** True iff the frontmatter declares `type: Attested Computation`. */
export function isAttestedComputation(fm: Record<string, unknown>): boolean {
  return typeof fm['type'] === 'string' && (fm['type'] as string).trim() === ATTESTED_COMPUTATION_TYPE;
}

/**
 * True iff the markdown body carries a conventional `# Computation` section
 * (spec §4.2) — the inline form of the computation. Matches a level-1/2 heading
 * whose text is exactly "Computation" (case-insensitive).
 */
export function hasComputationSection(body: string): boolean {
  return /^#{1,2}\s+Computation\s*$/im.test(body);
}

/** Read the Attested Computation contract from frontmatter (shape-tolerant). */
export function readAttestedContract(fm: Record<string, unknown>): AttestedContract {
  const runtime = typeof fm['runtime'] === 'string' ? (fm['runtime'] as string) : undefined;
  const computation = typeof fm['computation'] === 'string' ? (fm['computation'] as string) : undefined;
  return {
    runtime,
    parameters: readParameters(fm['parameters']),
    computation,
    executor: readExecutor(fm['executor']),
    attester: readAttester(fm['attester']),
  };
}

/**
 * Classify a path-valued field (spec §6.2): an absolute URL, a bundle-relative
 * path (`/…`), or a relative path (`./…`, `../…`, or a bare relative path).
 * Returns undefined for a non-string / empty value.
 */
export type PathValueKind = 'absolute-url' | 'bundle-relative' | 'relative';
export function classifyPathValue(value: unknown): PathValueKind | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const v = value.trim();
  // A path/URI carries no raw whitespace (URLs percent-encode it); a value with
  // spaces is a scope descriptor or a mistake, not a path-valued field.
  if (/\s/.test(v)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return 'absolute-url';
  if (v.startsWith('/')) return 'bundle-relative';
  return 'relative';
}

/**
 * Validate an Attested Computation concept's contract shape. Reports `critical`
 * only for a missing `runtime` (REQUIRED for the type, §10.2); everything else is
 * a `warning`. Validates parameter/receipt *names* only — never values.
 *
 * @param hasInlineComputation whether the concept body carries a `# Computation`
 *   fence (the computation may be inline OR by file; exactly one should be present).
 */
export function validateAttestedComputation(
  fm: Record<string, unknown>,
  path: string,
  hasInlineComputation: boolean,
): { issues: ConformanceIssue[]; readiness: AttestedReadiness } {
  const issues: ConformanceIssue[] = [];
  const c = readAttestedContract(fm);

  if (!c.runtime) {
    issues.push({
      path,
      code: 'attested.runtime.missing',
      severity: 'critical',
      message: '`runtime` is required for an Attested Computation (OKF v0.2 §10.2).',
    });
  }

  const hasFileComputation = !!c.computation;
  if (!hasInlineComputation && !hasFileComputation) {
    issues.push({
      path,
      code: 'attested.computation.missing',
      severity: 'warning',
      message:
        'No computation found: provide a `# Computation` fenced block or a `computation:` file path (§10.3).',
    });
  } else if (hasInlineComputation && hasFileComputation) {
    issues.push({
      path,
      code: 'attested.computation.duplicate',
      severity: 'warning',
      message:
        'Both an inline `# Computation` block and a `computation:` file are present; the file is used and the inline block is ignored (§10.3).',
    });
  }

  // Parameter names must be present and unique (names only, never values).
  const seen = new Set<string>();
  for (const p of c.parameters) {
    if (!p.name) {
      issues.push({
        path,
        code: 'attested.parameter.unnamed',
        severity: 'warning',
        message: 'A parameter is missing its `name` (§10.2).',
      });
      continue;
    }
    if (seen.has(p.name)) {
      issues.push({
        path,
        code: 'attested.parameter.duplicate',
        severity: 'warning',
        message: `Duplicate parameter name \`${p.name}\` (§10.2).`,
      });
    }
    seen.add(p.name);
  }

  // Path-valued fields, when present, must look like a path/URI (§6.2).
  for (const [label, value] of [
    ['computation', c.computation],
    ['executor.resource', c.executor?.resource],
    ['attester.resource', c.attester?.resource],
  ] as const) {
    if (value !== undefined && classifyPathValue(value) === undefined) {
      issues.push({
        path,
        code: 'attested.path.invalid',
        severity: 'warning',
        message: `\`${label}\` is not a valid path/URI (absolute URL, \`/bundle-relative\`, or relative) (§6.2).`,
      });
    }
  }

  const structuralReady = !!c.runtime && (hasInlineComputation || hasFileComputation);
  const assetsReferenced = !!(c.computation || c.executor?.resource || c.attester?.resource);
  const attestationReady = !!c.attester?.resource && !!c.executor?.receipt?.length;

  return { issues, readiness: { structuralReady, assetsReferenced, attestationReady } };
}

function readParameters(value: unknown): OkfParameter[] {
  if (!Array.isArray(value)) return [];
  const out: OkfParameter[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    const name = typeof rec['name'] === 'string' ? (rec['name'] as string) : '';
    const p: OkfParameter = { name };
    if (typeof rec['type'] === 'string') p.type = rec['type'] as string;
    if (typeof rec['required'] === 'boolean') p.required = rec['required'] as boolean;
    out.push(p);
  }
  return out;
}

function readExecutor(value: unknown): OkfExecutor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const executor: OkfExecutor = {};
  if (typeof rec['resource'] === 'string') executor.resource = rec['resource'] as string;
  if (Array.isArray(rec['receipt'])) {
    executor.receipt = (rec['receipt'] as unknown[]).filter((v): v is string => typeof v === 'string');
  }
  return executor.resource || executor.receipt ? executor : undefined;
}

function readAttester(value: unknown): OkfAttester | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const resource = typeof rec['resource'] === 'string' ? (rec['resource'] as string) : undefined;
  return resource ? { resource } : undefined;
}
