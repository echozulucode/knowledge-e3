/**
 * The OKF v0.2 actor convention (spec §7).
 *
 * Every identity field — `generated.by`, `verified[].by`, `sources[].author` —
 * uses one of three forms:
 * - `<producer>/<version>` — an agent or tool (`reference_agent/gemini-2.5-pro`).
 * - `human:<id>` — a person (`human:ericjzim`).
 * - `process:<id>` — an automated process (`process:git-mirror`).
 *
 * Trust tiering (§5.3) keys off the `human:` prefix, so it MUST be exact for
 * hand-authored or human-confirmed content. This module is the single place that
 * builds and classifies actor strings, shared by export, import, and trust-tier
 * derivation.
 */
import type { OkfActor } from './types.js';

/** The kind of actor a string denotes. `unknown` is anything unparseable. */
export type ActorKind = 'human' | 'process' | 'agent' | 'unknown';

export interface ParsedActor {
  kind: ActorKind;
  /** For `human`/`process`: the id after the prefix. For `agent`: the producer. */
  id: string;
  /** For `agent`: the version after the `/`. Absent otherwise. */
  version?: string;
}

/** Build a `human:<id>` actor. */
export function humanActor(id: string): OkfActor {
  return `human:${id}`;
}

/** Build a `process:<id>` actor. */
export function processActor(id: string): OkfActor {
  return `process:${id}`;
}

/** Build a `<producer>/<version>` agent actor. */
export function agentActor(producer: string, version: string): OkfActor {
  return `${producer}/${version}`;
}

/** True iff the actor is a person (`human:` prefix). The trust-tiering predicate. */
export function isHumanActor(actor: unknown): boolean {
  return typeof actor === 'string' && actor.startsWith('human:');
}

/** Classify an actor string into its kind and parts. */
export function parseActor(actor: string): ParsedActor {
  if (actor.startsWith('human:')) return { kind: 'human', id: actor.slice('human:'.length) };
  if (actor.startsWith('process:')) return { kind: 'process', id: actor.slice('process:'.length) };
  const slash = actor.indexOf('/');
  if (slash > 0 && slash < actor.length - 1) {
    return { kind: 'agent', id: actor.slice(0, slash), version: actor.slice(slash + 1) };
  }
  return { kind: 'unknown', id: actor };
}

/** E3 owner ids that denote the system rather than a real person. */
const SYSTEM_OWNER_IDS = new Set(['', 'local-system', 'system', 'anonymous', 'knowledge-e3']);

/**
 * Map an E3 owning-user id to a v0.2 actor. A real user id becomes `human:<id>`
 * (so human-authored content tiers as human-reviewed once verified); the system
 * / anonymous / absent owner becomes `process:knowledge-e3`.
 */
export function e3OwnerToActor(ownerId?: string | null): OkfActor {
  const id = (ownerId ?? '').trim();
  if (SYSTEM_OWNER_IDS.has(id.toLowerCase())) return processActor('knowledge-e3');
  return humanActor(id);
}
