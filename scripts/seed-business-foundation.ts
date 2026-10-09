import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { seedSystemRoles } from '../src/business-foundation/seed';
import { databaseErrorSummary } from './database-error';

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 15000,
    }),
  });
  try {
    console.log('Checking database connection...');
    await prisma.$queryRaw`SELECT 1`;
    console.log('Database connection established; seeding roles...');
    await prisma.$transaction((transaction) => seedSystemRoles(transaction), {
      maxWait: 60000,
      timeout: 60000,
    });
    console.log('Seeded the permission catalog and seven system roles.');
  } finally {
    await prisma.$disconnect();
  }
}
void main().catch((error: unknown) => {
  console.error(databaseErrorSummary(error));
  process.exitCode = 1;
});
