import { Injectable } from '@nestjs/common';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import { fromStroops, toStroops } from '../swaps/swap-math';
import { Prisma } from '../../generated/prisma/client';
import type { PaymentIntentStatus } from '../../generated/prisma/client';
import type {
  QueryAnalyticsDto,
  QueryAnalyticsLogsDto,
} from './dto/query-analytics.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

function assetLabel(asset: string): string {
  return !asset || asset === 'native' ? 'XLM' : asset;
}

/**
 * Sum decimal amount strings in stroops (bigint). Invalid / empty amounts
 * contribute 0 — same behaviour as the old Number-based helpers.
 */
export function sumAmounts(
  amounts: Iterable<string | null | undefined>,
): string {
  let total = 0n;
  for (const a of amounts) {
    if (!a) continue;
    try {
      total += toStroops(a);
    } catch {
      // skip malformed amounts
    }
  }
  return fromStroops(total);
}

/**
 * Normalize a Postgres `numeric::text` amount into a Stellar decimal string
 * (≤7 fractional digits, no scientific notation). Never touches `Number`.
 */
export function formatAmount(raw: string | null | undefined): string {
  if (raw == null || raw === '') return '0';
  const t = raw.trim();
  if (!t || t === '0') return '0';
  if (/^\d+(\.\d{1,7})?$/.test(t)) {
    return fromStroops(toStroops(t));
  }
  const [whole, frac = ''] = t.split('.');
  if (!whole || !/^\d+$/.test(whole)) return '0';
  const frac7 = (frac + '0000000').slice(0, 7);
  return fromStroops(BigInt(whole) * 10_000_000n + BigInt(frac7));
}

function asInt(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseInt(v, 10) || 0;
  return 0;
}

/**
 * Read-only aggregates derived from the consumer's existing payment intents and
 * webhook deliveries — no separate analytics store. Powers the dashboard's
 * Overview, Balances, Customers and Logs views.
 *
 * Money is aggregated in Postgres (`numeric`) or in stroops (`bigint`); no
 * payment amount ever passes through JavaScript `Number`.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mirror the APISIX consumer locally (and return null if it has no records yet). */
  private async resolveConsumerId(consumer: GatewayConsumer): Promise<string> {
    const local = await this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
    return local.id;
  }

  /**
   * Stellar network the caller is scoped to, from the forwarded API key env:
   * `prod` → public, otherwise testnet. Every payment metric is filtered by this
   * so the dashboard's testnet vs mainnet views show distinct numbers.
   */
  private network(consumer: GatewayConsumer): string {
    return consumer.environment === 'prod' ? 'public' : 'testnet';
  }

  private createdAtWhere(
    from?: string,
    to?: string,
  ): { createdAt?: { gte?: Date; lt?: Date } } {
    if (!from && !to) return {};
    return {
      createdAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lt: new Date(to) } : {}),
      },
    };
  }

  /** Parameterized SQL fragment for optional createdAt bounds. */
  private createdAtSql(from?: string, to?: string): Prisma.Sql {
    return Prisma.sql`
      ${from ? Prisma.sql`AND "createdAt" >= ${new Date(from)}` : Prisma.empty}
      ${to ? Prisma.sql`AND "createdAt" < ${new Date(to)}` : Prisma.empty}
    `;
  }

  // ── Overview summary ────────────────────────────────────────────────────────
  async summary(consumer: GatewayConsumer, query: QueryAnalyticsDto = {}) {
    const consumerId = await this.resolveConsumerId(consumer);
    const network = this.network(consumer);
    const { from, to } = query;
    const dateWhere = this.createdAtWhere(from, to);
    const dateSql = this.createdAtSql(from, to);

    // Series window: last 30 UTC days when no range; otherwise the requested window
    // (capped at 366 days so a wide filter cannot explode the sparkline).
    const seriesWindowEnd = to ? new Date(to) : new Date();
    const seriesWindowStart = from
      ? new Date(from)
      : new Date(Date.now() - 29 * DAY_MS);
    const spanDays =
      from || to
        ? Math.max(
            1,
            Math.min(
              366,
              Math.ceil(
                (seriesWindowEnd.getTime() - seriesWindowStart.getTime()) /
                  DAY_MS,
              ),
            ),
          )
        : 30;

    type VolumeRow = { asset: string; amount: string; count: unknown };
    type SeriesRow = { day: Date | string; count: unknown; volume: string };
    type CountRow = { count: unknown };

    const [
      statusRows,
      volumeRows,
      seriesRows,
      customerRows,
      recent,
      webhookStats,
    ] = await Promise.all([
      this.prisma.paymentIntent.groupBy({
        by: ['status'],
        where: { consumerId, network, ...dateWhere },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<VolumeRow[]>`
          SELECT
            CASE WHEN asset IS NULL OR asset = 'native' THEN 'XLM' ELSE asset END AS asset,
            COALESCE(SUM(amount::numeric), 0)::text AS amount,
            COUNT(*)::int AS count
          FROM payment_intent
          WHERE "consumerId" = ${consumerId}
            AND network = ${network}
            AND status = 'SUCCEEDED'
            ${dateSql}
          GROUP BY 1
          ORDER BY 1
        `,
      this.prisma.$queryRaw<SeriesRow[]>`
          SELECT
            (date_trunc('day', "createdAt" AT TIME ZONE 'UTC'))::date AS day,
            COUNT(*)::int AS count,
            COALESCE(
              SUM(
                CASE
                  WHEN status = 'SUCCEEDED' THEN amount::numeric
                  ELSE 0
                END
              ),
              0
            )::text AS volume
          FROM payment_intent
          WHERE "consumerId" = ${consumerId}
            AND network = ${network}
            AND "createdAt" >= ${seriesWindowStart}
            AND "createdAt" < ${seriesWindowEnd}
          GROUP BY 1
          ORDER BY 1
        `,
      this.prisma.$queryRaw<CountRow[]>`
          SELECT COUNT(DISTINCT source)::int AS count
          FROM payment_intent
          WHERE "consumerId" = ${consumerId}
            AND network = ${network}
            AND source IS NOT NULL
            ${dateSql}
        `,
      this.prisma.paymentIntent.findMany({
        where: {
          consumerId,
          network,
          status: 'SUCCEEDED',
          ...dateWhere,
        },
        select: {
          id: true,
          kind: true,
          status: true,
          amount: true,
          asset: true,
          destination: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
      Promise.all([
        this.prisma.webhookEndpoint.count({ where: { consumerId } }),
        this.prisma.webhookDelivery.count({
          where: { endpoint: { consumerId } },
        }),
        this.prisma.webhookDelivery.count({
          where: { endpoint: { consumerId }, status: 'FAILED' },
        }),
      ]),
    ]);
    const [endpointCount, deliveries, failedDeliveries] = webhookStats;

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of statusRows) {
      byStatus[r.status] = r._count._all;
      total += r._count._all;
    }
    const succeeded = byStatus['SUCCEEDED'] ?? 0;
    const successRate = total ? Math.round((succeeded / total) * 1000) / 10 : 0;

    const volume = volumeRows.map((v) => ({
      asset: v.asset,
      amount: formatAmount(v.amount),
      count: asInt(v.count),
    }));

    // Build the daily series skeleton (legacy layout when no from/to), then overlay SQL.
    const series: { date: string; count: number; volume: string }[] = [];
    const skeletonStart =
      from || to ? seriesWindowStart.getTime() : Date.now() - 29 * DAY_MS;
    for (let d = 0; d < spanDays; d++) {
      const day = new Date(skeletonStart + d * DAY_MS);
      series.push({
        date: day.toISOString().slice(0, 10),
        count: 0,
        volume: '0',
      });
    }
    const indexByDate = new Map(series.map((s, idx) => [s.date, idx]));
    for (const row of seriesRows) {
      const key =
        row.day instanceof Date
          ? row.day.toISOString().slice(0, 10)
          : String(row.day).slice(0, 10);
      const idx = indexByDate.get(key);
      if (idx === undefined) continue;
      series[idx].count = asInt(row.count);
      series[idx].volume = formatAmount(row.volume);
    }

    return {
      totals: {
        all: total,
        succeeded,
        pending: byStatus['PENDING'] ?? 0,
        submitted: byStatus['SUBMITTED'] ?? 0,
        failed: byStatus['FAILED'] ?? 0,
        cancelled: byStatus['CANCELLED'] ?? 0,
        expired: byStatus['EXPIRED'] ?? 0,
        successRate,
      },
      volume,
      webhooks: {
        endpoints: endpointCount,
        deliveries,
        failedDeliveries,
      },
      customers: asInt(customerRows[0]?.count),
      series,
      recent: recent.map((i) => this.recentRow(i)),
    };
  }

  private recentRow(i: {
    id: string;
    kind: string;
    status: PaymentIntentStatus;
    amount: string | null;
    asset: string;
    destination: string;
    createdAt: Date;
  }) {
    return {
      id: i.id,
      kind: i.kind,
      status: i.status,
      amount: i.amount,
      asset: assetLabel(i.asset),
      destination: i.destination,
      createdAt: i.createdAt,
    };
  }

  // ── Balances (settled per asset) ────────────────────────────────────────────
  async balances(consumer: GatewayConsumer, query: QueryAnalyticsDto = {}) {
    const consumerId = await this.resolveConsumerId(consumer);
    const network = this.network(consumer);
    const { from, to } = query;
    const dateSql = this.createdAtSql(from, to);

    type BalanceRow = {
      asset: string;
      settled: string;
      pending: string;
      settled_count: unknown;
    };

    const rows = await this.prisma.$queryRaw<BalanceRow[]>`
      SELECT
        CASE WHEN asset IS NULL OR asset = 'native' THEN 'XLM' ELSE asset END AS asset,
        COALESCE(
          SUM(
            CASE WHEN status = 'SUCCEEDED' THEN amount::numeric ELSE 0 END
          ),
          0
        )::text AS settled,
        COALESCE(
          SUM(
            CASE
              WHEN status IN ('PENDING', 'SUBMITTED') THEN amount::numeric
              ELSE 0
            END
          ),
          0
        )::text AS pending,
        COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS settled_count
      FROM payment_intent
      WHERE "consumerId" = ${consumerId}
        AND network = ${network}
        ${dateSql}
      GROUP BY 1
    `;

    const data = rows
      .map((v) => ({
        asset: v.asset,
        amount: formatAmount(v.settled),
        pending: formatAmount(v.pending),
        count: asInt(v.settled_count),
      }))
      .sort((a, b) => {
        const diff = toStroops(b.amount) - toStroops(a.amount);
        return diff > 0n ? 1 : diff < 0n ? -1 : 0;
      });

    return { data, total: data.length };
  }

  // ── API request logs (real inbound requests, with details) ──────────────────
  async apiLogs(
    consumer: GatewayConsumer,
    query: QueryAnalyticsLogsDto = { take: 100 },
  ) {
    const take = query.take ?? 100;
    // RequestLog is keyed by the forwarded consumer username (not the local id).
    const rows = await this.prisma.requestLog.findMany({
      where: { consumer: consumer.username },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const data = rows.map((r) => ({
      id: r.id,
      method: r.method,
      path: r.path,
      statusCode: r.statusCode,
      durationMs: r.durationMs,
      ip: r.ip,
      userAgent: r.userAgent,
      status:
        r.statusCode < 400 ? 'ok' : r.statusCode < 500 ? 'pending' : 'fail',
      at: r.createdAt,
    }));
    return { data, total: data.length };
  }

  // ── Webhook delivery logs (across all the consumer's endpoints) ──────────────
  async webhookLogs(
    consumer: GatewayConsumer,
    query: QueryAnalyticsLogsDto = { take: 100 },
  ) {
    const take = query.take ?? 100;
    const consumerId = await this.resolveConsumerId(consumer);
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { consumerId },
      select: { id: true, url: true },
    });
    if (!endpoints.length) return { data: [], total: 0 };

    const urlById = new Map(endpoints.map((e) => [e.id, e.url]));
    const deliveries = await this.prisma.webhookDelivery.findMany({
      where: { endpointId: { in: endpoints.map((e) => e.id) } },
      orderBy: { createdAt: 'desc' },
      take,
    });

    const data = deliveries.map((d) => ({
      id: d.id,
      endpointId: d.endpointId,
      url: urlById.get(d.endpointId) ?? null,
      eventType: d.eventType,
      eventId: d.eventId,
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      error: d.error,
      status:
        d.status === 'SUCCEEDED'
          ? 'ok'
          : d.status === 'FAILED'
            ? 'fail'
            : 'pending',
      at: d.lastAttemptAt ?? d.createdAt,
    }));
    return { data, total: data.length };
  }
}
