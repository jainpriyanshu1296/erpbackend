const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { provisionOrganization } = require('../../services/onboarding.service');
async function provisionOrg(input) {
  return provisionOrganization(input);
}
async function findUser(orgDb, email) {
  const [rows] = await orgDb.query('SELECT id,name,email,password_hash,role,is_active FROM users WHERE email = ? LIMIT 1', { replacements: [email] });
  return rows[0];
}
module.exports = { provisionOrg, findUser, bcrypt };
