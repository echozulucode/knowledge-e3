/**
 * Loading skeletons for the major views. Each placeholder matches the height
 * of the real content so swap-in does not shift layout.
 *
 * Wave J: uses design tokens for dark mode support.
 * Wave E3: replaces raw "Loading..." text strings.
 */

function Block({ className }: { className?: string }): JSX.Element {
  return (
    <div
      className={`animate-pulse rounded ${className ?? ''}`}
      style={{
        backgroundColor: 'var(--kp-surface-muted)',
      }}
    />
  );
}

export function PageListSkeleton(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} role="status" aria-label="Loading pages">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            borderRadius: 'var(--kp-radius-md)',
            border: '1px solid var(--kp-border-subtle)',
            backgroundColor: 'var(--kp-surface-raised)',
            padding: '16px',
          }}
        >
          <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Block className="h-5 w-2/3" />
            <Block className="h-3 w-1/3" />
          </div>
          <Block className="ml-4 h-3 w-20" />
        </div>
      ))}
      <span className="sr-only">Loading pages...</span>
    </div>
  );
}

export function PageViewSkeleton(): JSX.Element {
  return (
    <div className="space-y-4" role="status" aria-label="Loading page">
      <Block className="h-8 w-2/3" />
      <Block className="h-4 w-full" />
      <Block className="h-4 w-11/12" />
      <Block className="h-4 w-3/4" />
      <Block className="h-4 w-full" />
      <Block className="h-4 w-1/2" />
      <span className="sr-only">Loading page...</span>
    </div>
  );
}

export function SearchResultsSkeleton(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }} role="status" aria-label="Searching">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            borderRadius: 'var(--kp-radius-md)',
            border: '1px solid var(--kp-border-subtle)',
            backgroundColor: 'var(--kp-surface-raised)',
            padding: '16px',
          }}
        >
          <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Block className="h-5 w-1/2" />
            <Block className="h-3 w-1/4" />
          </div>
        </div>
      ))}
      <span className="sr-only">Searching...</span>
    </div>
  );
}
