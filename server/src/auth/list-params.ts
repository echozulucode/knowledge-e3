import { BadRequestException } from '@nestjs/common';

/**
 * `limit` / `offset` on the admin list routes (users, tokens): absent → undefined
 * (the service default); otherwise an integer ≥ `min`. Malformed is a 400, since
 * silently ignoring it would page the list wrongly.
 */
export function wholeNumber(raw: string | undefined, param: string, min: number): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < min) {
    throw new BadRequestException(`${param} must be a whole number${min > 0 ? ` of at least ${min}` : ''}`);
  }
  return Number(value);
}
