const crypto = require('crypto');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  if (req.secure || process.env.NODE_ENV === 'production') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
  next();
}

function safeRequestId(value) {
  const candidate = String(value || '');
  return /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

module.exports = { securityHeaders, safeRequestId };
