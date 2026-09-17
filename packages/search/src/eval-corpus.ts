/**
 * The shared eval corpus: the documents `eval/queries.yaml` is written against.
 *
 * A small engineering knowledge base: troubleshooting notes, runbooks, an FAQ,
 * blog posts, plus one deprecated item, one stale item, one process-generated
 * unverified metric, and one draft. Keep ids stable: eval/queries.yaml names them.
 *
 * It lives in `src/` rather than in this package's tests because the eval has to
 * run against BOTH providers (reader UX plan §5.8): the in-memory provider here,
 * and the real `SearchService` over a seeded SQLite database in
 * `server/tests/search-eval.e2e.test.ts`. One corpus, two implementations, one
 * set of expectations — which is the only way the eval measures the product's
 * search rather than the reference implementation's.
 */
import type { AuthoredSearchDoc } from './filter-semantics.js';

/**
 * The corpus as written, before `last_verified_at` is derived (below). Only the
 * two IoT documents name authors; every other item has none, which is also a
 * case `author:` has to handle.
 */
const DOCUMENTS: AuthoredSearchDoc[] = [
  {
    id: 'troubleshoot-docker-build-cache',
    slug: 'troubleshoot-docker-build-cache',
    title: 'Troubleshooting Docker build cache misses in CI',
    status: 'published',
    type: 'Troubleshooting',
    space_id: 'platform',
    topic: 'platform',
    tags: ['docker', 'ci', 'cache', 'buildkit'],
    categories: ['build'],
    groups: ['platform-eng'],
    updated_at: '2026-08-20T10:00:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    description: 'Why CI rebuilds every layer and how to make BuildKit cache hits reliable.',
    body_text:
      'Symptoms: every CI run rebuilds all Docker layers even when nothing changed. ' +
      'Causes: COPY . . before the dependency install invalidates the layer cache; the runner has no --cache-from source; ' +
      'the BuildKit inline cache is not exported. Fix: order Dockerfile steps so package manifests are copied first, ' +
      'export the cache with --cache-to type=registry, and pull it back with --cache-from on the next run.',
  },
  {
    id: 'runbook-postgres-failover',
    slug: 'runbook-postgres-failover',
    title: 'Runbook: Postgres primary failover',
    status: 'published',
    type: 'Runbook',
    space_id: 'sre',
    topic: 'sre',
    tags: ['postgres', 'database', 'on-call'],
    categories: ['operations'],
    groups: ['sre'],
    updated_at: '2026-07-11T08:30:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    description: 'Promote a replica when the primary is unreachable.',
    body_text:
      'When the primary is unreachable for more than 60 seconds, page the database owner and start the failover. ' +
      'Step 1: confirm replication lag on the replica with pg_stat_wal_receiver. Step 2: promote the replica with pg_ctl promote. ' +
      'Step 3: repoint the service DNS record and restart the connection pools. Step 4: rebuild the old primary as a replica once it is back.',
  },
  {
    id: 'faq-vpn-access',
    slug: 'faq-vpn-access',
    title: 'FAQ: VPN access and split tunneling',
    status: 'published',
    type: 'FAQ',
    space_id: 'platform',
    topic: 'platform',
    tags: ['vpn', 'networking', 'onboarding'],
    categories: ['access'],
    updated_at: '2026-06-02T14:00:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    description: 'Common questions about connecting to the corporate VPN.',
    body_text:
      'How do I get VPN access? Request the vpn-users group in the access portal; approval takes one business day. ' +
      'Why can I not reach internal hosts? Split tunneling only routes 10.0.0.0/8 through the tunnel, so check that the host resolves to an internal address. ' +
      'The client disconnects every hour: that is the idle timeout, enable keepalive in the client settings.',
  },
  {
    id: 'blog-prisma-to-kysely',
    slug: 'blog-prisma-to-kysely',
    title: 'Why we moved from Prisma to Kysely',
    status: 'published',
    type: 'Blog Post',
    space_id: 'platform',
    topic: 'platform',
    tags: ['typescript', 'database', 'kysely', 'prisma'],
    categories: ['engineering'],
    updated_at: '2026-05-14T09:15:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    description: 'A type-safe query builder gave us the SQL control an ORM kept hiding.',
    body_text:
      'Prisma served us well until the raw SQL escape hatches started outnumbering the generated queries. ' +
      'Kysely is a type-safe SQL query builder: migrations are plain SQL, the dialect system covers SQLite and Postgres, ' +
      'and full-text search no longer needs a workaround. The migration took two weeks and removed 1,200 lines of adapter code.',
  },
  {
    id: 'blog-sqlite-fts5-search',
    slug: 'blog-sqlite-fts5-search',
    title: 'Building search on SQLite FTS5',
    status: 'published',
    type: 'Blog Post',
    space_id: 'platform',
    topic: 'platform',
    tags: ['sqlite', 'search', 'fts5'],
    categories: ['engineering'],
    updated_at: '2026-04-03T16:45:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    description: 'How the knowledge hub indexes pages with FTS5 and ranks with weighted fields.',
    body_text:
      'FTS5 is a virtual table module that ships with SQLite. We create a pages_fts table with the porter unicode61 tokenizer ' +
      'and rebuild it from the pages table on every import. The MATCH operator handles phrase queries, and a weighted ranker ' +
      'layers title, tag, and body signals over the raw bm25 score.',
  },
  {
    id: 'runbook-kubernetes-node-drain',
    slug: 'runbook-kubernetes-node-drain',
    title: 'Runbook: draining a Kubernetes node for maintenance',
    status: 'published',
    type: 'Runbook',
    space_id: 'sre',
    topic: 'sre',
    tags: ['kubernetes', 'on-call', 'maintenance'],
    categories: ['operations'],
    groups: ['sre'],
    updated_at: '2026-08-01T11:00:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    description: 'Cordon, drain, and return a node safely.',
    body_text:
      'Cordon the node first with kubectl cordon so no new pods schedule there. ' +
      'Drain it with kubectl drain --ignore-daemonsets --delete-emptydir-data and wait for the pod disruption budgets to allow eviction. ' +
      'After maintenance, kubectl uncordon the node and confirm the workloads rebalance.',
  },
  {
    id: 'troubleshoot-node-heap-oom',
    slug: 'troubleshoot-node-heap-oom',
    title: 'Troubleshooting Node.js "heap out of memory" crashes',
    status: 'published',
    type: 'Troubleshooting',
    space_id: 'platform',
    topic: 'platform',
    tags: ['nodejs', 'memory', 'oom'],
    categories: ['runtime'],
    updated_at: '2026-07-28T13:20:00Z',
    display_state: 'published',
    trust_tier: 'machine-confirmed',
    description: 'FATAL ERROR: Reached heap limit — finding the leak and raising the ceiling.',
    body_text:
      'The process exits with FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory. ' +
      'First raise the ceiling with NODE_OPTIONS=--max-old-space-size=4096 to confirm the workload fits. ' +
      'Then capture a heap snapshot with --heapsnapshot-signal and compare retained sizes to find the leak; ' +
      'unbounded caches and event listener accumulation are the usual causes.',
  },
  {
    // Deprecated, with a successor.
    id: 'guide-jenkins-pipelines',
    slug: 'guide-jenkins-pipelines',
    title: 'Setting up Jenkins pipelines',
    status: 'published',
    type: 'Guide',
    space_id: 'platform',
    topic: 'platform',
    tags: ['ci', 'jenkins'],
    categories: ['build'],
    updated_at: '2024-11-05T10:00:00Z',
    lifecycle_status: 'deprecated',
    display_state: 'superseded',
    superseded_by: 'guide-github-actions-ci',
    trust_tier: 'human-reviewed',
    description: 'Legacy Jenkinsfile conventions for the shared build cluster.',
    body_text:
      'Declarative Jenkinsfiles live next to the code and use the shared library for checkout, build, and publish stages. ' +
      'This guide is superseded by CI with GitHub Actions; the Jenkins cluster is scheduled for decommissioning.',
  },
  {
    id: 'guide-github-actions-ci',
    slug: 'guide-github-actions-ci',
    title: 'CI with GitHub Actions',
    status: 'published',
    type: 'Guide',
    space_id: 'platform',
    topic: 'platform',
    tags: ['ci', 'github-actions'],
    categories: ['build'],
    groups: ['platform-eng'],
    updated_at: '2026-08-15T09:00:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    description: 'Workflow conventions, reusable actions, and caching for every repository.',
    body_text:
      'Every repository runs the shared workflow from .github/workflows/ci.yml: lint, typecheck, unit tests, and a Docker build on pull requests. ' +
      'Use actions/cache keyed on the lockfile hash for dependencies and the registry cache for Docker layers. ' +
      'Secrets come from the organisation environment, never from the repository.',
  },
  {
    // Stale: past its review horizon.
    id: 'runbook-tls-cert-renewal',
    slug: 'runbook-tls-cert-renewal',
    title: 'Runbook: renewing TLS certificates with cert-manager',
    status: 'published',
    type: 'Runbook',
    space_id: 'sre',
    topic: 'sre',
    tags: ['tls', 'kubernetes', 'cert-manager'],
    categories: ['operations'],
    groups: ['sre'],
    updated_at: '2025-09-01T07:00:00Z',
    display_state: 'needs-review',
    stale: true,
    stale_after: '2026-03-01',
    trust_tier: 'human-reviewed',
    description: 'What to do when a certificate is 14 days from expiry and cert-manager has not renewed it.',
    body_text:
      'cert-manager renews certificates automatically 30 days before expiry. When the renewal alert fires, ' +
      'check the Certificate resource with kubectl describe certificate and look at the Order and Challenge status. ' +
      'DNS-01 challenges fail most often because the DNS credentials secret rotated; update the secret and delete the failed Order to retry.',
  },
  {
    // Process-generated and not yet verified by anyone.
    id: 'metric-weekly-deploy-frequency',
    slug: 'metric-weekly-deploy-frequency',
    title: 'Weekly deploy frequency',
    status: 'published',
    type: 'Metric',
    space_id: 'platform',
    topic: 'platform',
    tags: ['dora', 'deploys', 'metrics'],
    updated_at: '2026-09-01T02:00:00Z',
    display_state: 'published',
    generated_by: 'process:deploy-metrics-nightly',
    trust_tier: 'unverified',
    description: 'Deploys per service per week, computed nightly from the release pipeline.',
    body_text:
      'Generated nightly by the deploy-metrics job. Last week: 142 production deploys across 31 services, ' +
      'median lead time 3.2 hours, change failure rate 4 percent. Values are unverified until a human reviews the pipeline mapping.',
  },
  {
    // Draft: hidden from anonymous readers.
    id: 'adr-postgres-cloud-edition',
    slug: 'adr-postgres-cloud-edition',
    title: 'ADR: Postgres for the cloud edition',
    status: 'draft',
    type: 'Decision',
    space_id: 'platform',
    topic: 'platform',
    tags: ['postgres', 'cloud', 'adr'],
    categories: ['engineering'],
    updated_at: '2026-09-03T18:00:00Z',
    display_state: 'draft',
    trust_tier: 'unverified',
    description: 'Keep SQLite for self-host; add Postgres behind the existing Kysely dialect seam.',
    body_text:
      'Context: the hosted edition needs durability and multi-tenant scale that a single SQLite file cannot offer. ' +
      'Decision: wire PostgresDialect in makeKysely, make migrations dialect-aware, and move FTS5 behind a SearchProvider ' +
      'so a Postgres tsvector provider can replace it.',
  },
  {
    // The acronym case (reader UX plan §5.3): a page ABOUT MQTT, titled and
    // tagged with it. Its words stay clear of every other case in queries.yaml.
    id: 'reference-mqtt-topic-hierarchy',
    slug: 'reference-mqtt-topic-hierarchy',
    title: 'MQTT topic hierarchy for plant sensors',
    status: 'published',
    type: 'Reference',
    space_id: 'iot',
    topic: 'iot',
    tags: ['mqtt', 'iot', 'messaging'],
    categories: ['integration'],
    updated_at: '2026-06-20T09:00:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    // Frontmatter `authors` (a list).
    authors: ['Ada Lovelace', 'Charles Babbage'],
    description: 'How site, line and sensor segments compose an MQTT topic, and which wildcards subscribers may use.',
    body_text:
      'Every publisher writes to site/line/cell/sensor/measurement. Subscribers use + for a single level and # for everything below it. ' +
      'A retained message keeps the last value for late subscribers. Telemetry publishes at QoS 1; commands that must not repeat use QoS 2.',
  },
  {
    // Mentions MQTT in its prose without being about it: the page the acronym
    // case must NOT put first.
    id: 'guide-sensor-gateway-onboarding',
    slug: 'guide-sensor-gateway-onboarding',
    title: 'Onboarding a sensor gateway',
    status: 'published',
    type: 'Guide',
    space_id: 'iot',
    topic: 'iot',
    tags: ['gateway', 'sensors'],
    categories: ['integration'],
    updated_at: '2026-08-10T15:00:00Z',
    display_state: 'published',
    trust_tier: 'human-reviewed',
    // Frontmatter `author` (a single name), the other spelling `author:` reads.
    author: 'Grace Hopper',
    description: 'Register the gateway, issue its client certificate and point its MQTT bridge at the plant broker.',
    body_text:
      'Register the gateway serial number in the device registry first. The gateway polls Modbus RTU meters on the line and ' +
      'republishes each reading to the MQTT broker under the site topic. Issue a client certificate per gateway; shared credentials ' +
      'make revocation impossible. Confirm the first readings arrive before mounting the enclosure.',
  },
];

/**
 * The corpus, with `last_verified_at` set on every verified item to its
 * `updated_at`. That is exactly what `server/tests/eval-corpus.ts` seeds — a
 * `verified` event dated `updated_at` — so the `verified` sort orders the same
 * items the same way in both providers without restating the date twelve times.
 */
export const EVAL_CORPUS: AuthoredSearchDoc[] = DOCUMENTS.map((doc) =>
  doc.trust_tier === 'human-reviewed' || doc.trust_tier === 'machine-confirmed' ? { ...doc, last_verified_at: doc.updated_at } : doc,
);
