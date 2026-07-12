/**
 * Side-by-side diff viewer for conflict resolution.
 * Renders left (server) and right (local) versions with synchronized scroll.
 */

import { useMemo, useRef } from 'react';
import { computeLineDiff, type DiffSegment } from './lineDiff.js';
import './SideBySideDiff.css';

export interface SideBySideDiffProps {
  left: string;
  right: string;
}

export function SideBySideDiff({ left, right }: SideBySideDiffProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Check if inputs are too large to diff inline
  const isTooLarge = left.length + right.length > 1_000_000;

  // Compute diff segments
  const segments = useMemo(() => {
    if (isTooLarge) {
      return [];
    }
    return computeLineDiff(left, right);
  }, [left, right, isTooLarge]);

  if (isTooLarge) {
    return (
      <div className="kp-diff-fallback">
        <p>Document too large to diff inline. Showing the first 200 differing lines.</p>
      </div>
    );
  }

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const scrollTop = (e.target as HTMLDivElement).scrollTop;
    const scrollLeft = (e.target as HTMLDivElement).scrollLeft;

    // Apply scroll to both columns
    const leftCol = containerRef.current.querySelector('.kp-diff-left');
    const rightCol = containerRef.current.querySelector('.kp-diff-right');

    if (leftCol instanceof HTMLElement) {
      leftCol.scrollTop = scrollTop;
      leftCol.scrollLeft = scrollLeft;
    }
    if (rightCol instanceof HTMLElement) {
      rightCol.scrollTop = scrollTop;
      rightCol.scrollLeft = scrollLeft;
    }
  };

  return (
    <div
      ref={containerRef}
      className="kp-diff-container"
      onScroll={handleScroll}
    >
      <div className="kp-diff-columns">
        {/* LEFT COLUMN: Server version */}
        <div className="kp-diff-left">
          <div className="kp-diff-column-header">
            <div className="kp-diff-column-title">Server version</div>
          </div>
          <div className="kp-diff-rows">
            {segments.map((seg, idx) => (
              <DiffRow
                key={`seg-${idx}`}
                segment={seg}
                position="left"
              />
            ))}
          </div>
        </div>

        {/* RIGHT COLUMN: Your version */}
        <div className="kp-diff-right">
          <div className="kp-diff-column-header">
            <div className="kp-diff-column-title">Your version</div>
          </div>
          <div className="kp-diff-rows">
            {segments.map((seg, idx) => (
              <DiffRow
                key={`seg-${idx}`}
                segment={seg}
                position="right"
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

interface DiffRowProps {
  segment: DiffSegment;
  position: 'left' | 'right';
}

function DiffRow({ segment, position }: DiffRowProps) {
  if (segment.kind === 'context') {
    return (
      <div className="kp-diff-row kp-diff-row-context">
        <div className="kp-diff-gutter">
          <span className="kp-diff-line-number">
            {position === 'left' ? segment.leftLine : segment.rightLine}
          </span>
        </div>
        <div className="kp-diff-content">
          <pre className="kp-diff-code">{position === 'left' ? segment.left : segment.right}</pre>
        </div>
      </div>
    );
  }

  if (segment.kind === 'delete') {
    return position === 'left' ? (
      <div className="kp-diff-row kp-diff-row-delete">
        <div className="kp-diff-gutter">
          <span className="kp-diff-line-number">{segment.leftLine}</span>
        </div>
        <div className="kp-diff-content">
          <pre className="kp-diff-code">{segment.line}</pre>
        </div>
      </div>
    ) : (
      <div className="kp-diff-row kp-diff-row-empty">
        <div className="kp-diff-gutter">
          <span className="kp-diff-line-number"></span>
        </div>
        <div className="kp-diff-content"></div>
      </div>
    );
  }

  if (segment.kind === 'insert') {
    return position === 'right' ? (
      <div className="kp-diff-row kp-diff-row-insert">
        <div className="kp-diff-gutter">
          <span className="kp-diff-line-number">{segment.rightLine}</span>
        </div>
        <div className="kp-diff-content">
          <pre className="kp-diff-code">{segment.line}</pre>
        </div>
      </div>
    ) : (
      <div className="kp-diff-row kp-diff-row-empty">
        <div className="kp-diff-gutter">
          <span className="kp-diff-line-number"></span>
        </div>
        <div className="kp-diff-content"></div>
      </div>
    );
  }

  return null;
}
