import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  QueryAnalyticsDto,
  QueryAnalyticsLogsDto,
} from './query-analytics.dto';

describe('QueryAnalyticsDto', () => {
  it('accepts valid ISO dates', async () => {
    const dto = plainToInstance(QueryAnalyticsDto, {
      from: '2026-01-01',
      to: '2026-02-01',
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects malformed from (would be HTTP 400 via ValidationPipe)', async () => {
    const dto = plainToInstance(QueryAnalyticsDto, { from: 'hola' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'from')).toBe(true);
  });

  it('allows omitting from/to (historical totals unchanged)', async () => {
    const dto = plainToInstance(QueryAnalyticsDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe('QueryAnalyticsLogsDto', () => {
  it('defaults take to 100 and accepts take=5', async () => {
    const empty = plainToInstance(QueryAnalyticsLogsDto, {});
    expect(empty.take).toBe(100);
    expect(await validate(empty)).toHaveLength(0);

    const limited = plainToInstance(QueryAnalyticsLogsDto, { take: '5' });
    expect(limited.take).toBe(5);
    expect(await validate(limited)).toHaveLength(0);
  });

  it('rejects take above the max', async () => {
    const dto = plainToInstance(QueryAnalyticsLogsDto, { take: '9999' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'take')).toBe(true);
  });
});
