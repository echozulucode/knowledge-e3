import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { UsersController } from './users.controller.js';
import { ApiTokensService } from './tokens.service.js';
import { AdminTokensController, MeTokensController } from './tokens.controller.js';
import { SessionGuard } from './auth.guard.js';
import { LoginThrottleService } from './throttle.js';
import { ConfigModule } from '../config/config.module.js';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController, UsersController, MeTokensController, AdminTokensController],
  providers: [
    AuthService,
    ApiTokensService,
    LoginThrottleService,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
