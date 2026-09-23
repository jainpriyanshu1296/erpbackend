const { Sequelize } = require('sequelize');

const MAX_CACHED_POOLS = 25;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Map of dbName -> { sequelize: Sequelize, lastAccessed: number }
const poolCache = new Map();

const poolConfig = {
  host: process.env.MASTER_DB_HOST || 'localhost',
  port: Number(process.env.MASTER_DB_PORT || 3306),
  dialect: 'mysql',
  logging: false,
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
};

/**
 * Get or create dynamic tenant Sequelize connection with LRU management
 */
function getOrgDb(dbName) {
  const now = Date.now();

  if (poolCache.has(dbName)) {
    const entry = poolCache.get(dbName);
    entry.lastAccessed = now;
    return entry.sequelize;
  }

  // Evict least recently used pool if cache limit reached
  if (poolCache.size >= MAX_CACHED_POOLS) {
    let oldestDb = null;
    let oldestTime = Infinity;

    for (const [db, entry] of poolCache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestDb = db;
      }
    }

    if (oldestDb) {
      const oldEntry = poolCache.get(oldestDb);
      poolCache.delete(oldestDb);
      oldEntry.sequelize.close().catch(() => {});
    }
  }

  const sequelize = new Sequelize(
    dbName,
    process.env.MASTER_DB_USER || 'root',
    process.env.MASTER_DB_PASS || '',
    poolConfig,
  );

  poolCache.set(dbName, { sequelize, lastAccessed: now });
  return sequelize;
}

// Periodic idle reaper (every 2 minutes)
const reaper = setInterval(
  () => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [db, entry] of poolCache.entries()) {
      if (entry.lastAccessed < cutoff) {
        poolCache.delete(db);
        entry.sequelize.close().catch(() => {});
      }
    }
  },
  2 * 60 * 1000,
);

if (reaper.unref) reaper.unref();

/**
 * Gracefully close all tenant pools
 */
async function closeOrgDbs() {
  clearInterval(reaper);
  const closers = [];
  for (const entry of poolCache.values()) {
    closers.push(entry.sequelize.close().catch(() => {}));
  }
  poolCache.clear();
  return Promise.all(closers);
}

module.exports = { getOrgDb, closeOrgDbs };
