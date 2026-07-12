import { Module } from '@nestjs/common';
import { BugReportController } from './bugreport.controller.js';

@Module({ controllers: [BugReportController] })
export class BugReportModule {}
