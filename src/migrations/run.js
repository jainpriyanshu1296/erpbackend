require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function splitStatements(sql) {
  const withoutComments = sql
    .replace(/--[^\r\n]*(?:\r?\n|$)/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutComments
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

async function executeMigrationSql(conn, dbName, sql) {
  for (const statement of splitStatements(sql)) {
    const indexMatch = statement.match(/^CREATE\s+(UNIQUE\s+)?INDEX\s+([`A-Za-z0-9_]+)\s+ON\s+([`A-Za-z0-9_.]+)\s*\(([^)]+)\)$/i);
    if (indexMatch) {
      const [, unique, rawIndex, rawTable, columns] = indexMatch;
      const indexName = rawIndex.replace(/`/g, '');
      const table = rawTable.replace(/`/g, '');
      const [indexes] = await conn.query(
        'SELECT 1 FROM information_schema.statistics WHERE table_schema=? AND table_name=? AND index_name=? LIMIT 1',
        [dbName, table, indexName]
      );
      if (!indexes.length) {
        await conn.query(`CREATE ${unique || ''}INDEX \`${indexName}\` ON \`${table}\` (${columns})`);
      }
      continue;
    }
    if (!/^ALTER\s+TABLE\s+/i.test(statement) || !/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i.test(statement)) {
      await conn.query(statement);
      continue;
    }

    const match = statement.match(/^ALTER\s+TABLE\s+([`A-Za-z0-9_.]+)\s+([\s\S]+)$/i);
    if (!match) throw new Error(`Unsupported ALTER TABLE migration syntax: ${statement}`);
    const table = match[1].replace(/`/g, '');
    const additions = [...match[2].matchAll(
      /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([`A-Za-z0-9_]+)\s+([\s\S]*?)(?=\s*,\s*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+|$)/gi
    )];
    if (!additions.length) throw new Error(`Unsupported ALTER TABLE migration syntax: ${statement}`);

    for (const [, rawColumn, definition] of additions) {
      const column = rawColumn.replace(/`/g, '');
      const [columns] = await conn.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=? LIMIT 1`,
        [dbName, table, column]
      );
      if (columns.length) continue;
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition.trim()}`);
    }
  }
}

async function applyMigrationsToDb(conn, dbName, kind) {
  console.log(`\n--- Migrating ${kind} database: ${dbName} ---`);
  if (kind === 'master') {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/`/g, '')}\``);
  }
  await conn.query(`USE \`${dbName.replace(/`/g, '')}\``);

  // Ensure migration tracking table exists
  await conn.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      migration_name VARCHAR(150) UNIQUE NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await conn.query(`CREATE TABLE IF NOT EXISTS migration_locks (
    lock_name VARCHAR(100) PRIMARY KEY, owner_id VARCHAR(100) NOT NULL,
    acquired_at DATETIME NOT NULL, expires_at DATETIME NOT NULL
  )`);

  const lockName = `migration:${kind}:${dbName}`;
  const owner = `${process.pid}:${Date.now()}`;
  await conn.query(
    `INSERT INTO migration_locks(lock_name,owner_id,acquired_at,expires_at)
     VALUES(?,?,NOW(),DATE_ADD(NOW(), INTERVAL 10 MINUTE))
     ON DUPLICATE KEY UPDATE owner_id=IF(expires_at < NOW(), VALUES(owner_id), owner_id),
       acquired_at=IF(expires_at < NOW(), VALUES(acquired_at), acquired_at),
       expires_at=IF(expires_at < NOW(), VALUES(expires_at), expires_at)`,
    [lockName, owner]
  );
  const [locks] = await conn.query('SELECT owner_id FROM migration_locks WHERE lock_name=?', [lockName]);
  if (!locks.length || locks[0].owner_id !== owner) throw new Error(`Migration already running for ${dbName}`);
  try {
    const [appliedRows] = await conn.query('SELECT migration_name FROM _migrations');
    const appliedSet = new Set(appliedRows.map(r => r.migration_name));
    const dir = path.join(__dirname, kind);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[SKIPPED] ${file} (already applied)`);
        continue;
      }
      console.log(`[APPLYING] ${file}...`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await executeMigrationSql(conn, dbName, sql);
        await conn.query('INSERT INTO _migrations (migration_name) VALUES (?)', [file]);
      } catch (error) {
        throw new Error(`Migration ${file} failed for ${dbName}: ${error.message}`);
      }
      console.log(`[DONE] ${file}`);
    }
  } finally {
    await conn.query('DELETE FROM migration_locks WHERE lock_name=? AND owner_id=?', [lockName, owner]).catch(() => {});
  }
}

async function run() {
  const args = process.argv.slice(2);
  const kind = args[0] || 'master';
  const target = args[1] || process.env.MIGRATION_ORG_DB;

  const conn = await mysql.createConnection({
    host: process.env.MASTER_DB_HOST || 'localhost',
    port: Number(process.env.MASTER_DB_PORT || 3306),
    user: process.env.MASTER_DB_USER || 'root',
    password: process.env.MASTER_DB_PASS || '',
    multipleStatements: true
  });

  try {
    if (kind === 'master') {
      const masterDb = process.env.MASTER_DB_NAME || 'masterERP';
      await applyMigrationsToDb(conn, masterDb, 'master');
    } else if (kind === 'org') {
      if (target === '--all' || args.includes('--all')) {
        const masterDb = process.env.MASTER_DB_NAME || 'masterERP';
        await conn.query(`USE \`${masterDb.replace(/`/g, '')}\``);
        const [orgs] = await conn.query('SELECT db_name, company_name FROM organizations WHERE is_active=1');
        console.log(`Found ${orgs.length} active organizations for migration.`);
        for (const org of orgs) await applyMigrationsToDb(conn, org.db_name, 'org');
      } else {
        if (!target) {
          throw new Error('Please specify an org database name (e.g. node src/migrations/run.js org org_acme) or use --all');
        }
        await applyMigrationsToDb(conn, target, 'org');
      }
    } else {
      throw new Error(`Unknown migration kind: ${kind}. Use 'master' or 'org'`);
    }
    console.log('\nMigration run completed successfully.');
  } finally {
    await conn.end();
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('[FATAL] Migration error:', err);
    process.exit(1);
  });
}

module.exports = { applyMigrationsToDb, run };
