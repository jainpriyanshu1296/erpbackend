require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

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
    await conn.query(sql);
    await conn.query('INSERT INTO _migrations (migration_name) VALUES (?)', [file]);
    console.log(`[DONE] ${file}`);
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
      const masterDb = process.env.MASTER_DB_NAME || 'erp_master';
      await applyMigrationsToDb(conn, masterDb, 'master');
    } else if (kind === 'org') {
      if (target === '--all' || args.includes('--all')) {
        const masterDb = process.env.MASTER_DB_NAME || 'erp_master';
        await conn.query(`USE \`${masterDb.replace(/`/g, '')}\``);
        const [orgs] = await conn.query('SELECT db_name, company_name FROM organizations WHERE is_active=1');
        console.log(`Found ${orgs.length} active organizations for migration.`);
        for (const org of orgs) {
          try {
            await applyMigrationsToDb(conn, org.db_name, 'org');
          } catch (err) {
            console.error(`[ERROR] Failed to migrate ${org.db_name} (${org.company_name}):`, err.message);
          }
        }
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

run().catch(err => {
  console.error('[FATAL] Migration error:', err);
  process.exit(1);
});

