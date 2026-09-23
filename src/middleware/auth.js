const jwt = require('jsonwebtoken');
const { fail } = require('../utils/response');
function secret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return process.env.JWT_SECRET;
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
function signToken(user, org) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      orgId: org && org.id,
      orgSlug: org && org.slug,
    },
    secret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' },
  );
}
function auth(req, res, next) {
  const token =
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    readCookie(req, 'erp_access');
  if (!token)
    return fail(res, 401, 'UNAUTHENTICATED', 'Authentication required');
  try {
    req.user = jwt.verify(token, secret());
    return next();
  } catch {
    return fail(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token');
  }
}
function setSessionCookies(res, accessToken, refreshToken) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.NODE_ENV === 'production' ? 'Strict' : 'Lax';
  const cookies = [
    `erp_access=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=900${secure}`,
    `erp_refresh=${encodeURIComponent(refreshToken)}; Path=/api/v1/auth; HttpOnly; SameSite=${sameSite}; Max-Age=2592000${secure}`,
  ];
  res.setHeader('Set-Cookie', cookies);
}
function clearSessionCookies(res) {
  res.setHeader('Set-Cookie', [
    'erp_access=; Path=/; HttpOnly; Max-Age=0',
    'erp_refresh=; Path=/api/v1/auth; HttpOnly; Max-Age=0',
  ]);
}
module.exports = {
  auth,
  signToken,
  readCookie,
  setSessionCookies,
  clearSessionCookies,
  secret,
};
