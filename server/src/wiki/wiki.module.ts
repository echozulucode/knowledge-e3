import { Module } from '@nestjs/common';
import { WikiService } from './wiki.service.js';

@Module({
  providers: [WikiService],
  exports: [WikiService],
})
export class WikiModule {}
