import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { toStroops } from '../swaps/swap-math';
import {
  AnalyticsService,
  formatAmount,
  sumAmounts,
} from './analytics.service';
import type { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';

function consumer(overrides: Partial<GatewayConsumer> = {}): GatewayConsumer {
  return {
    username: 'cosmos_test',
    credentialId: 'cred_1',
    environment: 'dev',
    role: 'admin',
    permissions: ['payments:read', 'webhooks:read'],
    organizationId: 'org_1',
    plan: 'pro',
    planSwapFeeBps: 50,
    ...overrides,
  };
}

describe('analytics money helpers (stroops)', () => {
  it('sums 1_000_000 amounts of 1234.5678901 exactly', () => {
    const amounts = Array.from({ length: 1_000_000 }, () => '1234.5678901');
    expect(sumAmounts(amounts)).toBe('1234567890.1');
  });

  it('serializes a single stroop as 0.0000001 (not 1e-7) and round-trips', () => {
    const formatted = formatAmount('0.0000001');
    expect(formatted).toBe('0.0000001');
    expect(formatted).not.toMatch(/e/i);
    expect(() => toStroops(formatted)).not.toThrow();
    expect(toStroops(formatted)).toBe(1n);
  });

  it('normalizes Postgres numeric::text with extra fractional digits', () => {
    expect(formatAmount('0.0000001000')).toBe('0.0000001');
    expect(formatAmount('1234567890.1000000')).toBe('1234567890.1');
  });
});

type FindManyArgs = { take?: number; [key: string]: unknown };

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: {
    consumer: { upsert: jest.Mock };
    paymentIntent: {
      groupBy: jest.Mock;
      findMany: jest.Mock;
    };
    webhookEndpoint: { count: jest.Mock; findMany: jest.Mock };
    webhookDelivery: { count: jest.Mock; findMany: jest.Mock };
    requestLog: { findMany: jest.Mock };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      consumer: {
        upsert: jest.fn().mockResolvedValue({ id: 'cons_1' }),
      },
      paymentIntent: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      webhookEndpoint: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      webhookDelivery: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      requestLog: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  function mockSummaryQueries(
    opts: {
      customers?: number;
      volume?: Array<{ asset: string; amount: string; count: number }>;
      balances?: Array<{
        asset: string;
        settled: string;
        pending: string;
        settled_count: number;
      }>;
    } = {},
  ) {
    // summary issues 3 $queryRaw calls in order: volume, series, customers
    // balances issues 1 $queryRaw
    let call = 0;
    prisma.$queryRaw.mockImplementation(() => {
      call += 1;
      if (opts.balances && call === 1 && !opts.volume) {
        return Promise.resolve(opts.balances);
      }
      if (call === 1) return Promise.resolve(opts.volume ?? []);
      if (call === 2) return Promise.resolve([]); // series
      if (call === 3) return Promise.resolve([{ count: opts.customers ?? 0 }]);
      return Promise.resolve(opts.balances ?? []);
    });
  }

  function rawSqlText(callArgs: unknown[]): string {
    const first = callArgs[0];
    if (Array.isArray(first)) {
      return (first as string[]).join('?');
    }
    if (
      first &&
      typeof first === 'object' &&
      'strings' in first &&
      Array.isArray((first as { strings: string[] }).strings)
    ) {
      return (first as { strings: string[] }).strings.join('?');
    }
    return String(first);
  }

  it('summary and balances never call findMany without take', async () => {
    mockSummaryQueries({ customers: 2 });
    await service.summary(consumer());

    mockSummaryQueries({
      balances: [
        {
          asset: 'XLM',
          settled: '1',
          pending: '0',
          settled_count: 1,
        },
      ],
    });
    await service.balances(consumer());

    const calls = prisma.paymentIntent.findMany.mock.calls as Array<
      [FindManyArgs]
    >;
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls) {
      expect(args.take).toBeDefined();
      expect(typeof args.take).toBe('number');
      expect(args.take).toBeGreaterThan(0);
    }
  });

  it('summary customers come from COUNT(DISTINCT source) SQL, not a JS Set', async () => {
    mockSummaryQueries({ customers: 7 });
    const result = await service.summary(consumer());
    expect(result.customers).toBe(7);

    const sqlTexts = (
      prisma.$queryRaw.mock.calls as unknown as unknown[][]
    ).map(rawSqlText);
    expect(
      sqlTexts.some((s) => /COUNT\s*\(\s*DISTINCT\s+source\s*\)/i.test(s)),
    ).toBe(true);
  });

  it('all $queryRaw calls use Prisma parameterized fragments (no string-built SQL)', async () => {
    mockSummaryQueries({ customers: 0 });
    await service.summary(consumer());
    mockSummaryQueries({
      balances: [
        {
          asset: 'XLM',
          settled: '0.0000001',
          pending: '0',
          settled_count: 1,
        },
      ],
    });
    await service.balances(consumer());

    for (const call of prisma.$queryRaw.mock.calls as unknown as unknown[][]) {
      const first = call[0];
      expect(first).toBeDefined();
      expect(typeof first).not.toBe('string');
    }
  });

  it('balances formats a single stroop without scientific notation', async () => {
    mockSummaryQueries({
      balances: [
        {
          asset: 'XLM',
          settled: '0.0000001',
          pending: '0',
          settled_count: 1,
        },
      ],
    });
    const result = await service.balances(consumer());
    expect(result.data).toHaveLength(1);
    expect(result.data[0].amount).toBe('0.0000001');
    expect(() => toStroops(result.data[0].amount)).not.toThrow();
  });

  it('balances sorts by amount using bigint (stroops), not Number', async () => {
    mockSummaryQueries({
      balances: [
        {
          asset: 'USDC',
          settled: '10',
          pending: '0',
          settled_count: 1,
        },
        {
          asset: 'XLM',
          settled: '100',
          pending: '0',
          settled_count: 2,
        },
      ],
    });
    const result = await service.balances(consumer());
    expect(result.data.map((d) => d.asset)).toEqual(['XLM', 'USDC']);
  });

  it('summary returns the expected shape with groupBy totals', async () => {
    prisma.paymentIntent.groupBy.mockResolvedValue([
      { status: 'SUCCEEDED', _count: { _all: 3 } },
      { status: 'PENDING', _count: { _all: 1 } },
    ]);
    prisma.paymentIntent.findMany.mockResolvedValue([
      {
        id: 'pi_1',
        kind: 'TX',
        status: 'SUCCEEDED',
        amount: '1.5',
        asset: 'native',
        destination: 'GDEST',
        createdAt: new Date('2026-01-15T12:00:00Z'),
      },
    ]);
    mockSummaryQueries({
      customers: 2,
      volume: [{ asset: 'XLM', amount: '4.5', count: 3 }],
    });
    prisma.webhookEndpoint.count.mockResolvedValue(1);
    prisma.webhookDelivery.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(2);

    const result = await service.summary(consumer());
    expect(result.totals).toEqual({
      all: 4,
      succeeded: 3,
      pending: 1,
      submitted: 0,
      failed: 0,
      cancelled: 0,
      expired: 0,
      successRate: 75,
    });
    expect(result.volume).toEqual([{ asset: 'XLM', amount: '4.5', count: 3 }]);
    expect(result.customers).toBe(2);
    expect(result.webhooks).toEqual({
      endpoints: 1,
      deliveries: 10,
      failedDeliveries: 2,
    });
    expect(result.series).toHaveLength(30);
    expect(result.recent).toHaveLength(1);
    expect(result.recent[0].asset).toBe('XLM');
  });

  it('apiLogs respects take from the query DTO', async () => {
    prisma.requestLog.findMany.mockResolvedValue([
      {
        id: '1',
        method: 'GET',
        path: '/v1/summary',
        statusCode: 200,
        durationMs: 12,
        ip: null,
        userAgent: null,
        createdAt: new Date(),
      },
    ]);
    await service.apiLogs(consumer(), { take: 5 });
    expect(prisma.requestLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });

  it('webhookLogs respects take from the query DTO', async () => {
    prisma.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'ep_1', url: 'https://example.com/hook' },
    ]);
    prisma.webhookDelivery.findMany.mockResolvedValue([]);
    await service.webhookLogs(consumer(), { take: 5 });
    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });
});
