import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';

/**
 * The outbox on its own, global: the mirror wiring (ItemsModule) and the write
 * seam (ContentModule, which imports ItemsModule) both need it, and it depends
 * only on the database — so it sits below both without an import cycle.
 */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
