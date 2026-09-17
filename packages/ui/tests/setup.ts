// Testing Library only auto-registers afterEach(cleanup) when vitest globals are
// on; they are off here, so unmount between tests explicitly.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
