require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const masterDb = require('../config/db');
const { validateEnv } = require('../config/env');

async function main() {
  validateEnv();
  const [email, password, name = 'Super Admin'] = process.argv.slice(2);
  if (!email || !password || password.length < 12) {
    throw new Error('Usage: npm run bootstrap:admin -- email password [name] (password must be 12+ characters)');
  }
  const hash = await bcrypt.hash(password, 12);
  await masterDb.query(
    `INSERT INTO admin_users(id,name,email,password_hash,role,is_active,must_change_password)
     VALUES(?,?,?,?, 'superadmin',1,0)
     ON DUPLICATE KEY UPDATE name=VALUES(name), password_hash=VALUES(password_hash),
       role='superadmin', is_active=1, must_change_password=0`,
    { replacements: [uuid(), name, email.toLowerCase(), hash] }
  );
  console.log(`Admin ${email.toLowerCase()} bootstrapped.`);
  await masterDb.close();
}
main().catch(async (error) => {
  console.error(error.message);
  await masterDb.close().catch(() => {});
  process.exitCode = 1;
});
