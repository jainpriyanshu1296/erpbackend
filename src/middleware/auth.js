const jwt = require('jsonwebtoken');
const { fail } = require('../utils/response');
function signToken(user, org) { return jwt.sign({ sub: user.id, email: user.email, role: user.role, orgId: org && org.id, orgSlug: org && org.slug }, process.env.JWT_SECRET || 'development-secret-change-me', { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }); }
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return fail(res, 401, 'UNAUTHENTICATED', 'Authentication required');
  try { req.user = jwt.verify(token, process.env.JWT_SECRET || 'development-secret-change-me'); return next(); } catch { return fail(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token'); }
}
module.exports = { auth, signToken };
