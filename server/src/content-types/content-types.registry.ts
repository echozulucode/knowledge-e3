/**
 * Content-type registry — the first-class knowledge "kinds" E3 recognizes.
 *
 * Each entry is an **OKF concept `type`**: the `label` is written verbatim into a
 * concept's frontmatter `type` field, so it stays OKF-conformant (OKF only
 * requires a non-empty `type`; the vocabulary is a producer convention). The
 * registry is the single source of truth consumed by:
 *   - the HTTP `GET /content-types` endpoint (web composer + editor),
 *   - the MCP `knowledge.list_content_types` tool (agents), and
 *   - `PagesService` (canonicalizing the derived `pages.type` column).
 *
 * It is intentionally *additive over* OKF, never restrictive: unknown types are
 * still accepted everywhere (import stays permissive). This list just makes the
 * common kinds first-class — with a starter template and domain frontmatter —
 * so authoring and retrieval fit the real use cases (troubleshooting, FAQ,
 * runbooks, blogs, source-linked notes) rather than one generic shape.
 */

/** A domain frontmatter field a content type surfaces beyond the base schema. */
export interface ContentTypeField {
  /** Frontmatter key. */
  key: string;
  /** Human label for editors/forms. */
  label: string;
  /** Editor control hint. `tags` = list of short values; `textarea` = multi-line. */
  type: 'text' | 'tags' | 'textarea';
  /** One-line guidance. */
  description?: string;
}

export interface ContentTypeDef {
  /** Stable kebab id (URL/select value), e.g. `troubleshooting-guide`. */
  key: string;
  /** OKF `type` string written to frontmatter, e.g. `Troubleshooting Guide`. */
  label: string;
  /** One-line description shown in pickers. */
  description: string;
  /** Web icon key (best-effort; falls back to a generic icon). */
  icon: string;
  /** Grouping for the picker, e.g. `Reference`, `Support`, `Publishing`. */
  group: string;
  /** Domain frontmatter fields this type adds beyond the base schema. */
  fields: ContentTypeField[];
  /** Extra frontmatter merged into a new item of this type. */
  defaultFrontmatter: Record<string, unknown>;
  /** Starter Markdown body scaffold (H2-first: the title stays the sole H1). */
  template: string;
}

const CONCEPT_TEMPLATE = `## Overview

Explain what this is and why it matters.

## Details

The substance goes here.

## Related

- Link related concepts with [[Wiki Links]].
`;

const TROUBLESHOOTING_TEMPLATE = `## Symptom

What the user sees.

## Applies to

Products, versions, configurations, environments.

## Quick checks

Fast checks that rule out common causes.

## Likely causes

Ranked causes with confidence and evidence.

## Diagnostic steps

Commands, expected output, and failure examples.

## Fix

Safe remediation steps.

## Verification

How to prove the issue is resolved.

## Escalation

When to stop and who/what to contact.

## Related

- Components, known issues, source modules, and FAQs.
`;

const FAQ_TEMPLATE = `## Question

State the recurring question in one line.

## Answer

A concise, authoritative answer. Link to deeper concepts rather than restating them.

## Related

- [[Related concept]]
`;

const RUNBOOK_TEMPLATE = `## Purpose

What this procedure accomplishes and when to run it.

## Preconditions

Access, state, and safety checks required before starting.

## Steps

1. First step — expected result.
2. Next step.

## Verification

How to confirm success.

## Rollback

How to safely undo.

## Escalation

Who to contact if it fails.
`;

const HOWTO_TEMPLATE = `## Goal

What you'll accomplish.

## Prerequisites

What you need first.

## Steps

1. First step.
2. Next step.

## Result

What success looks like.
`;

const ADR_TEMPLATE = `## Context

The forces at play and the problem being decided.

## Decision

What we decided to do.

## Consequences

Trade-offs, follow-ons, and what this makes easier or harder.

## Alternatives considered

Options weighed and why they were not chosen.
`;

const ARCH_NOTE_TEMPLATE = `## Overview

What the system/service/feature is.

## Components

The moving parts and their responsibilities.

## Data flow

How data and control move through it.

## Decisions

Key design choices (link [[ADR]]s).

## Related

- APIs, repos, diagrams, examples.
`;

const BLOG_TEMPLATE = `## Introduction

Set up the topic and why the reader should care.

## Body

The narrative. Link durable concepts instead of duplicating them.

## Conclusion

Takeaways and next steps.
`;

const SERIES_TEMPLATE = `## About this series

What the series covers and who it's for.

## Parts

1. [[First post]]
2. [[Second post]]
`;

const KNOWN_ISSUE_TEMPLATE = `## Summary

The bug or limitation in one or two sentences.

## Impact

Who is affected and how badly.

## Workaround

Interim steps to mitigate, if any.

## Status

Open / in-progress / fixed-in — and where the fix lives.

## Related

- [[Troubleshooting guide]], tickets, source modules.
`;

const GLOSSARY_TEMPLATE = `## Definition

A precise one- or two-sentence definition.

## Details

Nuance, scope, and common confusions.

## See also

- [[Related term]]
`;

const RELEASE_NOTE_TEMPLATE = `## Highlights

The most important changes in this release.

## Changes

- Change one.
- Change two.

## Upgrade notes

Anything operators or users must do to adopt it.
`;

export const CONTENT_TYPES: ContentTypeDef[] = [
  {
    key: 'concept',
    label: 'Concept',
    description: 'A general wiki/reference page explaining a system, feature, or idea.',
    icon: 'book',
    group: 'Reference',
    fields: [],
    defaultFrontmatter: {},
    template: CONCEPT_TEMPLATE,
  },
  {
    key: 'troubleshooting-guide',
    label: 'Troubleshooting Guide',
    description: 'Symptom-focused diagnostic page: symptom → cause → checks → fix → verify.',
    icon: 'wrench',
    group: 'Support',
    fields: [
      { key: 'symptoms', label: 'Symptoms', type: 'tags', description: 'Observable symptoms this guide addresses.' },
      { key: 'severity', label: 'Severity', type: 'text', description: 'e.g. low, medium, high, critical.' },
      { key: 'product', label: 'Product', type: 'text' },
      { key: 'component', label: 'Component', type: 'text' },
      { key: 'owner', label: 'Owner', type: 'text' },
    ],
    defaultFrontmatter: { symptoms: [], severity: '', product: '', component: '' },
    template: TROUBLESHOOTING_TEMPLATE,
  },
  {
    key: 'faq',
    label: 'FAQ',
    description: 'One recurring question with a concise, authoritative answer.',
    icon: 'circleQuestion',
    group: 'Support',
    fields: [],
    defaultFrontmatter: {},
    template: FAQ_TEMPLATE,
  },
  {
    key: 'runbook',
    label: 'Runbook',
    description: 'An operational procedure with preconditions, steps, verification, and rollback.',
    icon: 'listCheck',
    group: 'Operations',
    fields: [{ key: 'owner', label: 'Owner', type: 'text' }],
    defaultFrontmatter: {},
    template: RUNBOOK_TEMPLATE,
  },
  {
    key: 'how-to',
    label: 'How-To',
    description: 'A task-oriented guide: goal, prerequisites, steps, result.',
    icon: 'listCheck',
    group: 'Guides',
    fields: [],
    defaultFrontmatter: {},
    template: HOWTO_TEMPLATE,
  },
  {
    key: 'adr',
    label: 'ADR',
    description: 'Architecture Decision Record: context, decision, consequences, alternatives.',
    icon: 'scaleBalanced',
    group: 'Decisions',
    fields: [],
    defaultFrontmatter: {},
    template: ADR_TEMPLATE,
  },
  {
    key: 'architecture-note',
    label: 'Architecture Note',
    description: 'A system-design explanation: components, data flow, and decisions.',
    icon: 'diagramProject',
    group: 'Reference',
    fields: [],
    defaultFrontmatter: {},
    template: ARCH_NOTE_TEMPLATE,
  },
  {
    key: 'blog-post',
    label: 'Blog Post',
    description: 'A publishable article that links durable concepts.',
    icon: 'penNib',
    group: 'Publishing',
    fields: [
      { key: 'series', label: 'Series', type: 'text', description: 'Series slug this post belongs to, if any.' },
      { key: 'canonical_concepts', label: 'Canonical concepts', type: 'tags', description: 'Durable concept pages this article is grounded in.' },
    ],
    defaultFrontmatter: { published: false },
    template: BLOG_TEMPLATE,
  },
  {
    key: 'series',
    label: 'Series',
    description: 'An ordered collection of related posts or concepts.',
    icon: 'layerGroup',
    group: 'Publishing',
    fields: [],
    defaultFrontmatter: {},
    template: SERIES_TEMPLATE,
  },
  {
    key: 'known-issue',
    label: 'Known Issue',
    description: 'A bug/limitation with impact, workaround, and status.',
    icon: 'triangleExclamation',
    group: 'Support',
    fields: [{ key: 'severity', label: 'Severity', type: 'text' }],
    defaultFrontmatter: { severity: '' },
    template: KNOWN_ISSUE_TEMPLATE,
  },
  {
    key: 'glossary-term',
    label: 'Glossary Term',
    description: 'A shared-vocabulary definition.',
    icon: 'book',
    group: 'Reference',
    fields: [],
    defaultFrontmatter: {},
    template: GLOSSARY_TEMPLATE,
  },
  {
    key: 'release-note',
    label: 'Release Note',
    description: 'A version-specific summary of changes and upgrade notes.',
    icon: 'tag',
    group: 'Publishing',
    fields: [{ key: 'version', label: 'Version', type: 'text' }],
    defaultFrontmatter: {},
    template: RELEASE_NOTE_TEMPLATE,
  },
];

const BY_KEY = new Map(CONTENT_TYPES.map((t) => [t.key, t]));
const BY_LABEL = new Map(CONTENT_TYPES.map((t) => [t.label.toLowerCase(), t]));

/** The full registry (safe to serialize to clients). */
export function listContentTypes(): ContentTypeDef[] {
  return CONTENT_TYPES;
}

/** Slugify a free-form type string to the registry's key shape. */
export function slugifyType(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve a free-form type string (label or key, any case) to a known content
 * type, or `undefined` if it isn't in the registry.
 */
export function findContentType(input: string): ContentTypeDef | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return BY_LABEL.get(trimmed.toLowerCase()) ?? BY_KEY.get(slugifyType(trimmed));
}

/**
 * Canonicalize a frontmatter `type` for the derived `pages.type` column: known
 * types collapse to their canonical label (so `faq`, `FAQ`, `Faq` all index as
 * `FAQ` for reliable section/filter matching); unknown types pass through
 * trimmed (OKF stays permissive); empty/non-strings become `null`.
 */
export function canonicalTypeLabel(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return findContentType(trimmed)?.label ?? trimmed;
}
