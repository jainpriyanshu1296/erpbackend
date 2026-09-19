const { created, ok, fail, asyncHandler } = require('../../utils/response');
const { provisionOrg, findUser, bcrypt } = require('./auth.service');
const masterDb = require('../../config/db');
const { getOrgDb } = require('../../config/orgDb');
const { signToken, readCookie, setSessionCookies, clearSessionCookies, secret } = require('../../middleware/auth');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sendEmail } = require('../../services/email.service');
const { tenantSubdomain } = require('../../config/domain');
const { createPendingOrganization } = require('../../services/onboarding.service');
async function issueRefresh(orgDb, user, org) {
  const token = jwt.sign({ sub: user.id, email: user.email, role: user.role, orgId: org.id, orgSlug: org.slug }, secret(), { expiresIn: '30d' });
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await orgDb.query('INSERT INTO refresh_tokens (id,user_id,token,token_hash,expires_at) VALUES (?,?,?,?,DATE_ADD(NOW(), INTERVAL 30 DAY))', { replacements: [uuid(), user.id, '', hash] });
  return token;
}
const login = asyncHandler(async (req, res) => {
  const { email, password, org_slug } = req.body;
  const subdomain = tenantSubdomain(req);
  const requestedSlug = subdomain;
  if (!requestedSlug) return fail(res, 400, 'TENANT_DOMAIN_REQUIRED', 'Open the organization subdomain to sign in');
  const [orgs] = await masterDb.query(
    subdomain
      ? `SELECT o.* FROM organizations o INNER JOIN organization_domains d ON d.organization_id=o.id
         WHERE d.subdomain=? AND d.is_active=1 LIMIT 1`
      : 'SELECT * FROM organizations WHERE slug=? AND is_active=1 LIMIT 1',
    { replacements: [requestedSlug] }
  );
  if (!orgs.length) return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid organization or credentials');
  if (orgs[0].is_suspended) return fail(res, 403, 'ORG_SUSPENDED', 'This organization has been suspended. Please contact support.');
  if (!['active', 'trial'].includes(orgs[0].status || 'active')) return fail(res, 403, 'ORG_UNAVAILABLE', 'This organization is not active');
  const org = orgs[0]; const user = await findUser(getOrgDb(org.db_name), email);
  if (!user || !user.is_active || !(await bcrypt.compare(password || '', user.password_hash))) return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
  const orgDb = getOrgDb(org.db_name); const token = signToken(user, org); const refresh_token = await issueRefresh(orgDb, user, org);
  setSessionCookies(res, token, refresh_token);
  if (orgDb.query) await orgDb.query('UPDATE users SET last_login=NOW() WHERE id=?', { replacements: [user.id] });
  return ok(res, { user: { id: user.id, name: user.name, email: user.email, role: user.role }, org: { id: org.id, slug: org.slug, company_name: org.company_name } }, 'Login successful');
});
const register = asyncHandler(async (req, res) => {
  const missing = ['company_name', 'owner_email', 'password', 'subdomain', 'plan', 'duration_months'].filter(k => !req.body[k]);
  if (missing.length) return fail(res, 400, 'VALIDATION_ERROR', 'Required fields are missing', missing);
  const result = await createPendingOrganization(req.body);
  return created(res, result, 'Organization created and awaiting payment');
});
const me = asyncHandler(async (req, res) => ok(res, req.user));
const refresh = asyncHandler(async (req, res) => {
  const raw = readCookie(req, 'erp_refresh') || req.body?.refresh_token;
  if (!raw) return fail(res, 400, 'VALIDATION_ERROR', 'Refresh session is required');
  let decoded; try { decoded = jwt.verify(raw, secret()); } catch { decoded = null; }
  if (!decoded?.orgId || !decoded?.sub) return fail(res, 401, 'UNAUTHENTICATED', 'Invalid refresh token');
  const [orgs] = await masterDb.query('SELECT * FROM organizations WHERE id=? AND is_active=1', { replacements: [decoded.orgId] });
  if (!orgs.length) return fail(res, 401, 'UNAUTHENTICATED', 'Organization unavailable');
  const orgDb = getOrgDb(orgs[0].db_name);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const [rows] = await orgDb.query('SELECT * FROM refresh_tokens WHERE token_hash=? AND user_id=? AND expires_at>NOW()', { replacements: [hash, decoded.sub] });
  if (!rows.length) {
    // A previously rotated token is a replay: revoke the complete family.
    const [reused] = await orgDb.query('SELECT id FROM refresh_tokens WHERE token_hash=? AND revoked_at IS NOT NULL', { replacements: [hash] });
    if (reused.length) await orgDb.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=?', { replacements: [decoded.sub] });
    return fail(res, 401, reused.length ? 'REFRESH_TOKEN_REUSE' : 'UNAUTHENTICATED', 'Refresh token expired');
  }
  if (rows[0].revoked_at) {
    await orgDb.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=?', { replacements: [decoded.sub] });
    return fail(res, 401, 'REFRESH_TOKEN_REUSE', 'Refresh token reuse detected');
  }
  const [users] = await orgDb.query('SELECT id,email,role,name FROM users WHERE id=? AND is_active=1', { replacements: [decoded.sub] });
  const replacementId = uuid();
  await orgDb.query('UPDATE refresh_tokens SET revoked_at=NOW(), replaced_by=? WHERE id=?', { replacements: [replacementId, rows[0].id] });
  const token = signToken(users[0], orgs[0]); const refresh_token = await issueRefresh(orgDb, users[0], orgs[0]);
  setSessionCookies(res, token, refresh_token);
  return ok(res, { refreshed: true });
});
const logout = asyncHandler(async (req, res) => { const [orgs] = await masterDb.query('SELECT db_name FROM organizations WHERE id=?', { replacements: [req.user.orgId] }); if (orgs.length) await getOrgDb(orgs[0].db_name).query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL', { replacements: [req.user.sub] }); clearSessionCookies(res); return ok(res, null, 'Logged out'); });
const forgotPassword = asyncHandler(async (req, res) => {
  const slug = tenantSubdomain(req);
  if (!slug) return fail(res, 400, 'TENANT_DOMAIN_REQUIRED', 'Open the organization subdomain to reset the password');
  const [orgs] = await masterDb.query('SELECT db_name, is_suspended FROM organizations WHERE slug=? AND is_active=1', { replacements: [slug] });
  if (!orgs.length || orgs[0].is_suspended) return ok(res, null, 'If the account exists, reset instructions were sent');
  const db = getOrgDb(orgs[0].db_name); const [users] = await db.query('SELECT id FROM users WHERE email=? AND is_active=1', { replacements: [req.body.email] });
  if (users.length) {
    const raw = crypto.randomBytes(32).toString('hex');
    await db.query('INSERT INTO password_reset_tokens (id,user_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(), INTERVAL 1 HOUR))', { replacements: [uuid(), users[0].id, crypto.createHash('sha256').update(raw).digest('hex')] });
    const base = process.env.FRONTEND_URL || 'http://localhost:3000';
    await sendEmail({ to: req.body.email, subject: 'Reset your ERP password', text: `Reset your password: ${base}/reset-password?token=${raw}` });
  }
  return ok(res, null, 'If the account exists, reset instructions were sent');
});
const resetPassword = asyncHandler(async (req, res) => {
  const slug = tenantSubdomain(req);
  if (!slug) return fail(res, 400, 'TENANT_DOMAIN_REQUIRED', 'Open the organization subdomain to reset the password');
  const [orgs] = await masterDb.query('SELECT db_name FROM organizations WHERE slug=? AND is_active=1', { replacements: [slug] });
  if (!orgs.length || !req.body.token || !req.body.password) return fail(res, 400, 'VALIDATION_ERROR', 'Valid token and password are required');
  const db = getOrgDb(orgs[0].db_name); const hash = crypto.createHash('sha256').update(req.body.token).digest('hex'); const [rows] = await db.query('SELECT * FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW()', { replacements: [hash] });
  if (!rows.length) return fail(res, 400, 'INVALID_TOKEN', 'Reset token is invalid or expired');
  await db.query('UPDATE users SET password_hash=? WHERE id=?', { replacements: [await bcrypt.hash(req.body.password, 12), rows[0].user_id] }); await db.query('UPDATE password_reset_tokens SET used_at=NOW() WHERE id=?', { replacements: [rows[0].id] }); return ok(res, null, 'Password reset successful');
});

const adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return fail(res, 400, 'VALIDATION_ERROR', 'Email and password are required');

  const [admins] = await masterDb.query('SELECT * FROM admin_users WHERE email = ? AND is_active = 1', { replacements: [email] });
  if (!admins.length || !(await bcrypt.compare(password, admins[0].password_hash))) {
    return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid admin email or password');
  }

  const admin = admins[0];
  if (admin.must_change_password) return fail(res, 403, 'PASSWORD_ROTATION_REQUIRED', 'Administrator password rotation is required');
  const token = jwt.sign(
    { sub: admin.id, name: admin.name, email: admin.email, role: admin.role || 'superadmin' },
    secret(),
    { expiresIn: '8h' }
  );

  setSessionCookies(res, token, '');
  return ok(res, { user: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } }, 'Admin login successful');
});
const adminLogout = asyncHandler(async (req, res) => {
  clearSessionCookies(res);
  return ok(res, null, 'Logged out');
});

module.exports = { register, login, me, refresh, logout, forgotPassword, resetPassword, adminLogin, adminLogout };
