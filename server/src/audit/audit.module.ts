import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditRetentionService } from './audit-retention.service.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditRetentionService],
  exports: [AuditService],
})
export class AuditModule {}
