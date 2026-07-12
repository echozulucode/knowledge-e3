import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedUser } from './auth.service.js';

export const Public = () => SetMetadata('public', true);
export const AdminOnly = () => SetMetadata('admin', true);
/** Marks a read (GET) endpoint as viewable by anonymous visitors when the
 * instance's read-access mode is `public`. Writes must never use this. */
export const PublicRead = () => SetMetadata('publicRead', true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthedUser | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req.user;
  },
);
