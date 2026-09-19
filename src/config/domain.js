const baseDomain = String(process.env.PLATFORM_DOMAIN || 'daanoday.com').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');

function requestHost(req) {
  // Express only exposes forwarded values when the configured proxy is trusted.
  const value = req.hostname || req.headers.host || '';
  return String(value).split(',')[0].trim().split(':')[0].toLowerCase();
}

function tenantSubdomain(req) {
  const host = requestHost(req);
  if (!host || host === baseDomain || host === `www.${baseDomain}`) return null;
  if (!host.endsWith(`.${baseDomain}`)) return null;
  const prefix = host.slice(0, -(`.${baseDomain}`).length);
  if (!prefix || prefix.includes('.')) return null;
  return prefix;
}

function hostnameForSubdomain(subdomain) {
  return `${String(subdomain).toLowerCase()}.${baseDomain}`;
}

module.exports = { baseDomain, requestHost, tenantSubdomain, hostnameForSubdomain };
