import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentConsumer } from '../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { AnalyticsService } from './analytics.service';
import {
  QueryAnalyticsDto,
  QueryAnalyticsLogsDto,
} from './dto/query-analytics.dto';

// Read-only dashboard aggregates. URI versioning => /v1/...
@ApiTags('analytics')
@Controller({ version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('summary')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary:
      'Overview metrics: totals, settled volume, webhook health, 30-day series',
  })
  @ApiOkResponse({ description: 'Aggregated overview for the consumer.' })
  summary(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.analytics.summary(consumer, query);
  }

  @Get('balances')
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'Settled (and pending) amount per asset' })
  @ApiOkResponse({ description: 'Balances per asset for the consumer.' })
  balances(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryAnalyticsDto,
  ) {
    return this.analytics.balances(consumer, query);
  }

  @Get('logs')
  @RequirePermissions('payments:read')
  @ApiOperation({
    summary: 'Recent API requests reaching the service (with details)',
  })
  @ApiOkResponse({ description: 'API request log for the consumer.' })
  apiLogs(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryAnalyticsLogsDto,
  ) {
    return this.analytics.apiLogs(consumer, query);
  }

  @Get('logs/webhooks')
  @RequirePermissions('webhooks:read')
  @ApiOperation({
    summary: 'Recent webhook deliveries across all endpoints (with details)',
  })
  @ApiOkResponse({ description: 'Webhook delivery log for the consumer.' })
  webhookLogs(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryAnalyticsLogsDto,
  ) {
    return this.analytics.webhookLogs(consumer, query);
  }
}
