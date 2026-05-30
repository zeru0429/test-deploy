import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const MAX_QUERY_STATS = 500;

const databaseUrl = process.env["DATABASE_URL"];

if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is not set");
}

// ===============================
// CONFIG
// ===============================

const SLOW_QUERY_THRESHOLD_MS = Number(
  process.env["SLOW_QUERY_THRESHOLD_MS"] ?? 1000,
);

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** Off in production unless explicitly enabled — query events add CPU and log I/O. */
const ENABLE_QUERY_TIMING =
  process.env["ENABLE_QUERY_TIMING"] === "true" ||
  (!IS_PRODUCTION && process.env["ENABLE_QUERY_TIMING"] !== "false");

const IS_DEV = process.env.NODE_ENV === "development";

// ===============================
// PRISMA PG ADAPTER
// ===============================

const poolMax = Number(process.env["PG_POOL_MAX"] ?? (IS_PRODUCTION ? 15 : 20));

const adapter = new PrismaPg({
  connectionString: databaseUrl,
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// ===============================
// QUERY STATS TYPES
// ===============================

type QueryStat = {
  count: number;
  totalTime: number;
  maxTime: number;
  lastSlowQuery?: Date;
};

const queryTimings = new Map<string, QueryStat>();

// ===============================
// PRISMA CLIENT
// ===============================

const prisma = new PrismaClient({
  adapter,

  log: [
    ...(ENABLE_QUERY_TIMING
      ? [
          {
            level: "query" as const,
            emit: "event" as const,
          },
        ]
      : []),

    {
      level: "error" as const,
      emit: "stdout" as const,
    },

    {
      level: "warn" as const,
      emit: "stdout" as const,
    },
  ],
});

// ===============================
// QUERY LOGGER
// ===============================

if (ENABLE_QUERY_TIMING) {
  prisma.$on("query", (e) => {
    try {
      const duration = e.duration;

      // Normalize query
      const normalizedQuery = e.query.replace(/\s+/g, " ").trim();

      const queryKey = normalizedQuery.substring(0, 150);

      // Limit memory usage
      if (queryTimings.size >= MAX_QUERY_STATS && !queryTimings.has(queryKey)) {
        const firstKey = queryTimings.keys().next().value;

        if (firstKey) {
          queryTimings.delete(firstKey);
        }
      }

      const existingStats = queryTimings.get(queryKey);

      const stats: QueryStat = existingStats ?? {
        count: 0,
        totalTime: 0,
        maxTime: 0,
      };

      stats.count += 1;
      stats.totalTime += duration;
      stats.maxTime = Math.max(stats.maxTime, duration);

      // ===============================
      // SLOW QUERY LOGGING
      // ===============================

      if (duration >= SLOW_QUERY_THRESHOLD_MS) {
        stats.lastSlowQuery = new Date();

        console.warn("\n🐌 SLOW QUERY DETECTED");
        console.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.warn(`⏱ Duration : ${duration}ms`);
        console.warn(`📅 Time     : ${new Date().toISOString()}`);
        console.warn(
          `📊 Average  : ${(stats.totalTime / stats.count).toFixed(2)}ms`,
        );
        console.warn(`🔥 Max Time : ${stats.maxTime}ms`);
        console.warn(`🔁 Count    : ${stats.count}`);

        console.warn("\n📝 QUERY");
        console.warn(normalizedQuery.substring(0, 500));

        if (e.params && e.params !== "[]") {
          console.warn("\n📦 PARAMS");
          console.warn(e.params.substring(0, 300));
        }

        console.warn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

        // Critical query warning
        if (duration >= SLOW_QUERY_THRESHOLD_MS * 3) {
          console.error("🚨 CRITICAL QUERY PERFORMANCE ISSUE");
          console.error(
            "Recommendation: Check indexes, joins, N+1 queries, or pagination.",
          );
        }
      }

      // ===============================
      // DEV QUERY LOGGING
      // ===============================

      if (IS_DEV) {
        const icon = duration >= SLOW_QUERY_THRESHOLD_MS ? "🐌" : "⚡";

        console.log(
          `${icon} Prisma Query (${duration}ms)`,
          normalizedQuery.substring(0, 200),
        );
      }

      queryTimings.set(queryKey, stats);
    } catch (err) {
      console.error("❌ Query logging failed:", err);
    }
  });
}

// ===============================
// CONNECTION STATE
// ===============================

let isConnected = false;

// ===============================
// CONNECT DATABASE
// ===============================

export const connectDB = async (): Promise<PrismaClient> => {
  if (isConnected) {
    console.log("✅ Using existing Prisma connection");
    return prisma;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;

    isConnected = true;

    console.log("🎯 Prisma connected to PostgreSQL database");

    return prisma;
  } catch (error) {
    const err = error as {
      message?: string;
      code?: string;
    };

    console.error("❌ Prisma connection error:", err.message);

    if (err.code === "P1001") {
      console.error("❌ Cannot connect to PostgreSQL server.");
    }

    if (err.code === "P1017") {
      console.error("❌ Database connection closed unexpectedly.");
    }

    isConnected = false;

    throw error;
  }
};

// ===============================
// GET PRISMA INSTANCE
// ===============================

export const getPrisma = (): PrismaClient => prisma;

// ===============================
// QUERY PERFORMANCE STATS
// ===============================

export const getQueryStats = () => {
  return [...queryTimings.entries()]
    .map(([query, stats]) => ({
      query,

      count: stats.count,

      avgTime: Number((stats.totalTime / stats.count).toFixed(2)),

      maxTime: stats.maxTime,

      totalTime: stats.totalTime,

      lastSlowQuery: stats.lastSlowQuery,
    }))
    .sort((a, b) => b.totalTime - a.totalTime);
};

// ===============================
// RESET QUERY STATS
// ===============================

export const resetQueryStats = () => {
  queryTimings.clear();

  console.log("✅ Query statistics reset");
};

// ===============================
// CHECK CONNECTION
// ===============================

export const checkConnection = async (): Promise<{
  connected: boolean;
  error?: string;
}> => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    return {
      connected: true,
    };
  } catch (error) {
    isConnected = false;

    const err = error as {
      message?: string;
    };

    return {
      connected: false,
      error: err.message ?? "Unknown error",
    };
  }
};

// ===============================
// DISCONNECT
// ===============================

export const disconnectDB = async (): Promise<void> => {
  await prisma.$disconnect();

  isConnected = false;

  console.log("✅ Prisma connection closed");
};

// ===============================
// EXPORTS
// ===============================

export { prisma };
