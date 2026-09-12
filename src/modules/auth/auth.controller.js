const { created, ok, fail, asyncHandler } = require('../../utils/response');
const { provisionOrg, findUser, bcrypt } = require('./auth.service');
const masterDb = require('../../config/db');
const { getOrgDb } = require('../../config/orgDb');
const { signToken } = require('../../middleware/auth');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sendEmail } = require('../../services/email.service');
const secret = () => process.env.JWT_SECRET || 'development-secret-change-me';
async function issueRefresh(orgDb, user, org) {
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role, orgId: org.id, orgSlug: org.slug }, secret(), { expiresIn: '30d' });
  await orgDb.query('INSERT INTO refresh_tokens (id,user_id,token,expires_at) VALUES (?,?,?,DATE_ADD(NOW(), INTERVAL 30 DAY))', { replacements: [uuid(), user.id, token] });
  return token;
}
const login = asyncHandler(async (req, res) => {
  const { email, password, org_slug } = req.body;
  const [orgs] = await masterDb.query('SELECT * FROM organizations WHERE slug = ? AND is_active = 1', { replacements: [org_slug || req.headers['x-org-slug']] });
  if (!orgs.length) return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid organization or credentials');
  const org = orgs[0]; const user = await findUser(getOrgDb(org.db_name), email);
  if (!user || !user.is_active || !(await bcrypt.compare(password || '', user.password_hash))) return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  const orgDb = getOrgDb(org.db_name); const token = signToken(user, org); const refresh_token = await issueRefresh(orgDb, user, org);
  if (orgDb.query) await orgDb.query('UPDATE users SET last_login=NOW() WHERE id=?', { replacements: [user.id] });
  return ok(res, { token, refresh_token, user: { id: user.id, name: user.name, email: user.email, role: user.role }, org: { id: org.id, slug: org.slug, company_name: org.company_name } }, 'Login successful');
});
const register = asyncHandler(async (req, res) => {
  const missing = ['company_name', 'owner_email', 'password'].filter(k => !req.body[k]);
  if (missing.length) return fail(res, 400, 'VALIDATION_ERROR', 'Required fields are missing', missing);
  const result = await provisionOrg(req.body);
  const token = signToken(result.user, result.org);
  const refresh_token = await issueRefresh(result.orgDb, result.user, result.org);
  return created(res, { token, refresh_token, user: result.user, org: result.org }, 'Organization registered');
});
const me = asyncHandler(async (req, res) => ok(res, req.user));
const refresh = asyncHandler(async (req, res) => {
  const raw = req.body?.refresh_token; if (!raw) return fail(res, 400, 'VALIDATION_ERROR', 'refresh_token is required');
  let decoded; try { decoded = jwt.verify(raw, secret()); } catch { decoded = null; }
  if (!decoded?.orgId || !decoded?.sub) return fail(res, 401, 'UNAUTHENTICATED', 'Invalid refresh token');
  const [orgs] = await masterDb.query('SELECT * FROM organizations WHERE id=? AND is_active=1', { replacements: [decoded.orgId] });
  if (!orgs.length) return fail(res, 401, 'UNAUTHENTICATED', 'Organization unavailable');
  const orgDb = getOrgDb(orgs[0].db_name); const [rows] = await orgDb.query('SELECT * FROM refresh_tokens WHERE token=? AND user_id=? AND expires_at>NOW()', { replacements: [raw, decoded.sub] });
  if (!rows.length) return fail(res, 401, 'UNAUTHENTICATED', 'Refresh token expired');
  const [users] = await orgDb.query('SELECT id,email,role,name FROM users WHERE id=? AND is_active=1', { replacements: [decoded.sub] });
  await orgDb.query('DELETE FROM refresh_tokens WHERE token=?', { replacements: [raw] });
  const token = signToken(users[0], orgs[0]); const refresh_token = await issueRefresh(orgDb, users[0], orgs[0]);
  return ok(res, { token, refresh_token });
});
const logout = asyncHandler(async (req, res) => { const [orgs] = await masterDb.query('SELECT db_name FROM organizations WHERE id=?', { replacements: [req.user.orgId] }); if (orgs.length) await getOrgDb(orgs[0].db_name).query('DELETE FROM refresh_tokens WHERE user_id=?', { replacements: [req.user.sub] }); return ok(res, null, 'Logged out'); });
const forgotPassword = asyncHandler(async (req, res) => {
  const [orgs] = await masterDb.query('SELECT db_name FROM organizations WHERE slug=? AND is_active=1', { replacements: [req.body.org_slug || req.headers['x-org-slug']] });
  if (!orgs.length) return ok(res, null, 'If the account exists, reset instructions were sent');
  const db = getOrgDb(orgs[0].db_name); const [users] = await db.query('SELECT id FROM users WHERE email=? AND is_active=1', { replacements: [req.body.email] });
  if (users.length) {
    const raw = crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO password_reset_tokens (id,user_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(), INTERVAL 1 HOUR))', { replacements: [uuid(), users[0].id, crypto.createHash('sha256').update(raw).digest('hex')] });
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    await sendEmail({ to: req.body.email, subject: 'Reset your ERP password', text: `Reset your password: ${base}/reset-password?token=${raw}&org_slug=${req.body.org_slug || req.headers['x-org-slug']}` });
  }
  return ok(res, null, 'If the account exists, reset instructions were sent');
});
const resetPassword = asyncHandler(async (req, res) => {
  const [orgs] = await masterDb.query('SELECT db_name FROM organizations WHERE slug=? AND is_active=1', { replacements: [req.body.org_slug || req.headers['x-org-slug']] });
  if (!orgs.length || !req.body.token || !req.body.password) return fail(res, 400, 'VALIDATION_ERROR', 'Valid token and password are required');
  const db = getOrgDb(orgs[0].db_name); const hash = crypto.createHash('sha256').update(req.body.token).digest('hex'); const [rows] = await db.query('SELECT * FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW()', { replacements: [hash] });
  if (!rows.length) return fail(res, 400, 'INVALID_TOKEN', 'Reset token is invalid or expired');
  await db.query('UPDATE users SET password_hash=? WHERE id=?', { replacements: [await bcrypt.hash(req.body.password, 12), rows[0].user_id] }); await db.query('UPDATE password_reset_tokens SET used_at=NOW() WHERE id=?', { replacements: [rows[0].id] }); return ok(res, null, 'Password reset successful');
});

const adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return fail(res, 400, 'VALIDATION_ERROR', 'Email and password are required');

  // Seed default superadmin if table is completely empty
  const [allAdmins] = await masterDb.query('SELECT COUNT(*) as count FROM admin_users');
  if (Number(allAdmins[0]?.count || 0) === 0) {
    const defaultHash = await bcrypt.hash('Admin@123', 12);
    await masterDb.query(
      'INSERT INTO admin_users (id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      { replacements: [uuid(), 'Super Admin', 'admin@erp.com', defaultHash, 'superadmin'] }
    );
  }

  const [admins] = await masterDb.query('SELECT * FROM admin_users WHERE email = ? AND is_active = 1', { replacements: [email] });
  if (!admins.length || !(await bcrypt.compare(password, admins[0].password_hash))) {
    return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid admin email or password');
  }

  const admin = admins[0];
  const token = jwt.sign(
    { sub: admin.id, name: admin.name, email: admin.email, role: admin.role || 'superadmin' },
    secret(),
    { expiresIn: '8h' }
  );

  return ok(res, { token, user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } }, 'Admin login successful');
});

module.exports = { register, login, me, refresh, logout, forgotPassword, resetPassword, adminLogin };
