import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/**
 * Optional date window for overview / balances. No defaults — omitting both
 * keeps historical totals identical to the pre-filter behaviour (only the
 * sparkline series is inherently last-30-days).
 */
export class QueryAnalyticsDto {
  @ApiPropertyOptional({
    description: 'Inclusive start of the window (ISO 8601 date or datetime)',
    example: '2026-01-01',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'Exclusive end of the window (ISO 8601 date or datetime)',
    example: '2026-02-01',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** Pagination for API / webhook log endpoints. */
export class QueryAnalyticsLogsDto {
  @ApiPropertyOptional({ default: 100, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  take: number = 100;
}
