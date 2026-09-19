const requiredInProduction = [
  'JWT_SECRET',
  'MASTER_DB_HOST',
  'MASTER_DB_USER',
  'MASTER_DB_NAME',
  'PLATFORM_DOMAIN',
  'FRONTEND_URL',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET'
];

function validateEnv() {
  const production = process.env.NODE_ENV === 'production';
  const missing = requiredInProduction.filter((key) => !String(process.env[key] || '').trim());
  if (production && (missing.length || String(process.env.JWT_SECRET || '').length < 32)) {
    throw new Error(`Invalid production configuration. Required values missing or weak: ${missing.concat(
      String(process.env.JWT_SECRET || '').length < 32 ? ['JWT_SECRET(32+ chars)'] : []
    ).join(', ')}`);
  }
  if (production && process.env.ALLOW_LEGACY_ORG_CONTEXT === 'true') {
    throw new Error('ALLOW_LEGACY_ORG_CONTEXT must be disabled in production');
  }
  return { production };
}

module.exports = { validateEnv };
