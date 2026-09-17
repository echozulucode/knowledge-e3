import { describe, expect, it } from 'vitest';
import { imageActionError } from './imageAssetPolicy.js';

describe('image asset action errors', () => {
  it('surfaces a structured API conflict message', () => {
    expect(imageActionError({ statusCode: 409, message: 'file is referenced' }, 'Delete failed.')).toBe(
      'file is referenced',
    );
    expect(imageActionError(null, 'Delete failed.')).toBe('Delete failed.');
  });
});
