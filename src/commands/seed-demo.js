require('dotenv').config();
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { v4: uuid } = require('uuid');
const masterDb = require('../config/db');
const { applyMigrationsToDb } = require('../migrations/run');

const DEMO_EMAIL = 'demo@erp.com';
const DEMO_SLUG = 'erp';
const DEMO_DB = 'org_erp';
const DEMO_PLAN = 'pro';

function required(name) {
  const value = String(process.env[name] || '');
  if (!value || value.length < 12) throw new Error(`${name} is required and must be at least 12 characters`);
  return value;
}

async function main() {
  const tenantPassword = required('DEMO_ORG_PASSWORD');
  const superAdminPassword = required('DEMO_SUPERADMIN_PASSWORD');
  const tenantHash = await bcrypt.hash(tenantPassword, 12);
  const superAdminHash = await bcrypt.hash(superAdminPassword, 12);
  const hostname = `${DEMO_SLUG}.${String(process.env.PLATFORM_DOMAIN || 'daanoday.com').toLowerCase()}`;

  const [existing] = await masterDb.query('SELECT id, db_name FROM organizations WHERE slug=? OR db_name=? LIMIT 1', {
    replacements: [DEMO_SLUG, DEMO_DB]
  });
  const organizationId = existing[0]?.id || uuid();
  const tx = await masterDb.transaction();
  try {
    if (!existing.length) {
      await masterDb.query(
        `INSERT INTO organizations
         (id,slug,db_name,company_name,owner_name,owner_email,plan,status,is_active,is_trial,plan_started_at,plan_expires_at)
         VALUES(?,?,?,?,?,'demo@erp.com','pro','active',1,0,NOW(),DATE_ADD(NOW(), INTERVAL 12 MONTH))`,
        { replacements: [organizationId, DEMO_SLUG, DEMO_DB, 'Demo ERP Organization', 'Demo Owner'], transaction: tx }
      );
    } else {
      await masterDb.query(
        `UPDATE organizations
         SET company_name='Demo ERP Organization', owner_name='Demo Owner', owner_email=?,
             plan='pro', status='active', is_active=1, is_trial=0,
             plan_started_at=COALESCE(plan_started_at,NOW()),
             plan_expires_at=DATE_ADD(NOW(), INTERVAL 12 MONTH)
         WHERE id=?`,
        { replacements: [DEMO_EMAIL, organizationId], transaction: tx }
      );
    }
    await masterDb.query(
      `INSERT INTO organization_domains(id,organization_id,hostname,subdomain,is_primary,is_active)
       VALUES(?,?,?,?,1,1)
       ON DUPLICATE KEY UPDATE organization_id=VALUES(organization_id),is_active=1,is_primary=1`,
      { replacements: [uuid(), organizationId, hostname, DEMO_SLUG], transaction: tx }
    );
    await masterDb.query(
      `INSERT INTO provisioning_jobs(id,organization_id,status,completed_at,last_error)
       VALUES(?,?, 'provisioned', NOW(), NULL)
       ON DUPLICATE KEY UPDATE status='provisioned',completed_at=NOW(),last_error=NULL`,
      { replacements: [uuid(), organizationId], transaction: tx }
    );
    const [pricing] = await masterDb.query(
      'SELECT amount FROM plan_pricing WHERE plan=? AND duration_months=12 AND is_active=1 LIMIT 1',
      { replacements: [DEMO_PLAN], transaction: tx }
    );
    if (!pricing.length) throw new Error('Yearly pro plan pricing is missing');
    const [moduleRows] = await masterDb.query('SELECT module_key FROM modules ORDER BY sort_order,id', { transaction: tx });
    if (!moduleRows.length) throw new Error('No modules are available');
    const total = Number(pricing[0].amount);
    const [subscriptions] = await masterDb.query(
      `SELECT id FROM subscriptions WHERE org_id=? AND plan=? AND duration_months=12 LIMIT 1`,
      { replacements: [organizationId, DEMO_PLAN], transaction: tx }
    );
    const subscriptionId = subscriptions[0]?.id || uuid();
    if (subscriptions.length) {
      await masterDb.query(
        `UPDATE subscriptions
         SET amount=?,status='active',starts_at=COALESCE(starts_at,NOW()),
             expires_at=DATE_ADD(NOW(),INTERVAL 12 MONTH)
         WHERE id=?`,
        { replacements: [total, subscriptionId], transaction: tx }
      );
    } else {
      await masterDb.query(
        `INSERT INTO subscriptions
         (id,org_id,plan,duration_months,amount,currency,status,starts_at,expires_at)
         VALUES(?,?,?,12,?,'INR','active',NOW(),DATE_ADD(NOW(),INTERVAL 12 MONTH))`,
        { replacements: [subscriptionId, organizationId, DEMO_PLAN, total], transaction: tx }
      );
    }
    await masterDb.query('DELETE FROM subscription_items WHERE subscription_id=?', {
      replacements: [subscriptionId],
      transaction: tx
    });
    for (const module of moduleRows) {
      const [modulePrices] = await masterDb.query(
        'SELECT amount FROM module_pricing WHERE module_key=? AND duration_months=12 AND is_active=1 LIMIT 1',
        { replacements: [module.module_key], transaction: tx }
      );
      await masterDb.query(
        `INSERT INTO subscription_items(id,subscription_id,module_key,amount)
         VALUES(?,?,?,?)
         ON DUPLICATE KEY UPDATE amount=VALUES(amount)`,
        { replacements: [uuid(), subscriptionId, module.module_key, Number(modulePrices[0]?.amount || 0)], transaction: tx }
      );
      await masterDb.query(
        `INSERT INTO org_modules(org_id,module_key,is_active) VALUES(?,?,1)
         ON DUPLICATE KEY UPDATE is_active=1`,
        { replacements: [organizationId, module.module_key], transaction: tx }
      );
    }
    await masterDb.query(
      `INSERT INTO admin_users(id,name,email,password_hash,role,is_active,must_change_password)
       VALUES(?,?,?,?, 'superadmin',1,0)
       ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),role='superadmin',
         is_active=1,must_change_password=0`,
      { replacements: [uuid(), 'Super Admin', 'admin@daanoday.com', superAdminHash], transaction: tx }
    );
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  let root;
  try {
    root = await mysql.createConnection({
      host: process.env.MASTER_DB_HOST || 'localhost',
      port: Number(process.env.MASTER_DB_PORT || 3306),
      user: process.env.MASTER_DB_USER || 'root',
      password: process.env.MASTER_DB_PASS || '',
      multipleStatements: true
    });
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${DEMO_DB}\``);
    await root.changeUser({ database: DEMO_DB });
    await applyMigrationsToDb(root, DEMO_DB, 'org');
    const [users] = await root.query('SELECT id FROM users WHERE email=? LIMIT 1', [DEMO_EMAIL]);
    if (users.length) {
      await root.query('UPDATE users SET password_hash=?,name=?,role="admin",is_active=1 WHERE id=?', [tenantHash, 'Demo Owner', users[0].id]);
    } else {
      await root.query('INSERT INTO users(id,name,email,password_hash,role,is_active) VALUES(?,?,?,?,?,1)', [uuid(), 'Demo Owner', DEMO_EMAIL, tenantHash, 'admin']);
    }
    await root.end();
    console.log(`Demo tenant ready: ${hostname} (${DEMO_DB})`);
    console.log('Super Admin ready: admin@daanoday.com');
  } finally {
    await root?.end().catch(() => {});
    await masterDb.close();
  }
}

main().catch(async error => {
  console.error(`[FATAL] Demo seed failed: ${error.message}`);
  await masterDb.close().catch(() => {});
  process.exitCode = 1;
});
