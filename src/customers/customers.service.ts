import { Injectable, NotFoundException } from '@nestjs/common';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { PrismaService } from '../prisma/prisma.service';
import { fromStroops, toStroops } from '../swaps/swap-math';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  private resolveConsumer(consumer: GatewayConsumer) {
    return this.prisma.consumer.upsert({
      where: { apisixUsername: consumer.username },
      create: {
        apisixUsername: consumer.username,
        credentialId: consumer.credentialId,
      },
      update: { credentialId: consumer.credentialId },
    });
  }

  async create(consumer: GatewayConsumer, dto: CreateCustomerDto) {
    const local = await this.resolveConsumer(consumer);
    return this.prisma.customer.create({
      data: {
        consumerId: local.id,
        name: dto.name,
        alias: dto.alias ?? null,
        note: dto.note ?? null,
        email: dto.email ?? null,
        account: dto.account ?? null,
        reference: dto.reference ?? null,
      },
    });
  }

  async findAll(consumer: GatewayConsumer) {
    const local = await this.resolveConsumer(consumer);

    // Enrich each stored customer with on-chain stats derived from payment
    // intents whose payer (source) matches the customer's account.
    const [customers, intents] = await Promise.all([
      this.prisma.customer.findMany({
        where: { consumerId: local.id },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.paymentIntent.findMany({
        where: { consumerId: local.id, source: { not: null } },
        select: { source: true, amount: true, status: true },
      }),
    ]);

    const stats = new Map<
      string,
      { payments: number; succeeded: number; total: bigint }
    >();
    for (const i of intents) {
      const acct = i.source as string;
      const cur = stats.get(acct) ?? { payments: 0, succeeded: 0, total: 0n };
      cur.payments += 1;
      if (i.status === 'SUCCEEDED') {
        cur.succeeded += 1;
        if (i.amount) {
          try {
            cur.total += toStroops(i.amount);
          } catch {
            // skip malformed amounts
          }
        }
      }
      stats.set(acct, cur);
    }

    const data = customers.map((c) => {
      const s = (c.account && stats.get(c.account)) || {
        payments: 0,
        succeeded: 0,
        total: 0n,
      };
      return {
        ...c,
        payments: s.payments,
        succeeded: s.succeeded,
        total: fromStroops(s.total),
      };
    });

    return { data, total: data.length };
  }

  async findOne(consumer: GatewayConsumer, id: string) {
    const local = await this.resolveConsumer(consumer);
    const customer = await this.prisma.customer.findFirst({
      where: { id, consumerId: local.id },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async update(consumer: GatewayConsumer, id: string, dto: UpdateCustomerDto) {
    await this.findOne(consumer, id);
    return this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.alias !== undefined ? { alias: dto.alias } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.account !== undefined ? { account: dto.account } : {}),
        ...(dto.reference !== undefined ? { reference: dto.reference } : {}),
      },
    });
  }

  async remove(consumer: GatewayConsumer, id: string) {
    await this.findOne(consumer, id);
    await this.prisma.customer.delete({ where: { id } });
    return { id, deleted: true };
  }
}
