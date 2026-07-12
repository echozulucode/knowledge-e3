import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.decorators.js';

@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz() {
    return 'ok';
  }

  @Public()
  @Get('readyz')
  readyz() {
    return 'ok';
  }
}
