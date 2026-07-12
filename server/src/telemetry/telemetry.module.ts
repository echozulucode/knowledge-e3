import { Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller.js';

@Module({ controllers: [TelemetryController] })
export class TelemetryModule {}
