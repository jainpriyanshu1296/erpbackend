const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const mysql = require('mysql2/promise');
const masterDb = require('../../config/db');
const { getOrgDb } = require('../../config/orgDb');
const { slugify } = require('../../utils/helpers');
const fs = require('fs');
const path = require('path');
async function provisionOrg(input) {
  const slug = slugify(input.slug || input.company_name);
  const id = uuid(); const dbName = `org_${slug.replace(/-/g, '_')}`;
  const exists = await masterDb.query('SELECT id FROM organizations WHERE slug = ? OR db_name = ?', { replacements: [slug, dbName] });
  if (exists[0].length) { const e = new Error('Organization slug already exists'); e.status = 409; e.code = 'CONFLICT'; throw e; }
  const adminId = uuid(); const passwordHash = await bcrypt.hash(input.password, 12);
  const root = await mysql.createConnection({ host: process.env.MASTER_DB_HOST || 'localhost', port: Number(process.env.MASTER_DB_PORT || 3306), user: process.env.MASTER_DB_USER || 'root', password: process.env.MASTER_DB_PASS || '', multipleStatements: true });
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await root.changeUser({ database: dbName });
  const migrationDir = path.join(__dirname, '../../migrations/org');
  for (const file of fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort()) {
    await root.query(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
  }
  await root.query('INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)', [adminId, input.owner_name || input.company_name, input.owner_email, passwordHash, 'admin']);
  await root.end();
  await masterDb.query('INSERT INTO organizations (id,slug,db_name,company_name,owner_name,owner_email,owner_phone,gstin,state,plan,trial_ends_at) VALUES (?,?,?,?,?,?,?,?,?,?,DATE_ADD(NOW(), INTERVAL 14 DAY))', { replacements: [id, slug, dbName, input.company_name, input.owner_name || '', input.owner_email, input.owner_phone || '', input.gstin || null, input.state || null, 'free'] });
  const orgDb = getOrgDb(dbName);
  return { org: { id, slug, db_name: dbName, company_name: input.company_name }, user: { id: adminId, name: input.owner_name || input.company_name, email: input.owner_email, role: 'admin' }, orgDb };
}
async function findUser(orgDb, email) {
  const [rows] = await orgDb.query('SELECT id,name,email,password_hash,role,is_active FROM users WHERE email = ? LIMIT 1', { replacements: [email] });
  return rows[0];
}
module.exports = { provisionOrg, findUser, bcrypt };
