const test = require('node:test');
const assert = require('node:assert/strict');
const { tenantSubdomain } = require('../src/config/domain');
const permission = require('../src/middleware/permission');
const {
  isPaymentAlreadyProcessed,
  provisioningFailureState,
} = require('../src/services/onboarding.service');

function responseDouble() {
  return {
    statusCode: 200,
    body: null,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('tenant isolation accepts only one first-level tenant hostname', () => {
  assert.equal(
    tenantSubdomain({ hostname: 'abc.daanoday.com', headers: {} }),
    'abc',
  );
  assert.equal(
    tenantSubdomain({ hostname: 'xyz.daanoday.com', headers: {} }),
    'xyz',
  );
  assert.equal(
    tenantSubdomain({ hostname: 'abc.erp.daanoday.com', headers: {} }),
    null,
  );
  assert.equal(
    tenantSubdomain({ hostname: 'abc.example.com', headers: {} }),
    null,
  );
});

test('permission middleware denies an unprivileged role and records the decision', async () => {
  const writes = [];
  const req = {
    user: { sub: 'user-1', role: 'staff' },
    orgDb: {
      query(sql, options) {
        writes.push(options.replacements);
        return Promise.resolve([[]]);
      },
    },
    method: 'POST',
    originalUrl: '/api/v1/sales/invoices',
    ip: '127.0.0.1',
  };
  const res = responseDouble();
  permission('sales', 'can_create')(req, res, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'FORBIDDEN');
  assert.equal(
    writes.at(-1)[6],
    JSON.stringify({
      allowed: false,
      method: 'POST',
      path: '/api/v1/sales/invoices',
    }),
  );
});

test('admin permission bypass is still audited', async () => {
  const writes = [];
  const req = {
    user: { sub: 'admin-1', role: 'admin' },
    orgDb: {
      query(sql, options) {
        writes.push(options.replacements);
        return Promise.resolve([[]]);
      },
    },
    method: 'PUT',
    originalUrl: '/settings/company',
    ip: '127.0.0.1',
  };
  await new Promise((resolve, reject) =>
    permission('settings', 'can_edit')(req, responseDouble(), (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  assert.equal(
    writes.at(-1)[6],
    JSON.stringify({ allowed: true, method: 'PUT', path: '/settings/company' }),
  );
});

test('duplicate paid payment is idempotent', () => {
  assert.equal(isPaymentAlreadyProcessed({ status: 'paid' }), true);
  assert.equal(isPaymentAlreadyProcessed({ status: 'activated' }), true);
  assert.equal(isPaymentAlreadyProcessed({ status: 'pending' }), false);
});

test('provisioning failures become retryable state', () => {
  assert.deepEqual(
    provisioningFailureState(new Error('tenant migration failed')),
    {
      status: 'retry_pending',
      last_error: 'tenant migration failed',
      retryable: true,
    },
  );
});
