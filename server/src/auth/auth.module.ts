import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { UsersController } from './users.controller.js';
import { SessionGuard } from './auth.guard.js';
import { ConfigModule } from '../config/config.module.js';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController, UsersController],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
