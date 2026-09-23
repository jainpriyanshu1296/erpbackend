const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/nextDomains.service');

test('next domains expose explicit tenant-safe definitions', () => {
  assert.equal(service.DEFINITIONS.quality.table, 'qc_inspections');
  assert.equal(service.DEFINITIONS.employees.table, 'employees');
  assert.equal(service.DEFINITIONS.tax.table, 'tax_transactions');
});

test('employee creation validates required identity fields', async () => {
  const req = { body: { employee_code: 'E-1' } };
  assert.throws(
    () => service.assertInput(service.DEFINITIONS.employees, req.body),
    /name is required/,
  );
});

test('idempotent domain creation returns the original response', async () => {
  const calls = [];
  const db = {
    async query(sql, options) {
      calls.push(sql);
      if (sql.startsWith('SELECT response_json'))
        return [[{ response_json: JSON.stringify({ id: 'existing' }) }]];
      throw new Error('write should not run for a replay');
    },
  };
  const req = {
    orgDb: db,
    get: () => 'request-1',
    user: { sub: 'u1' },
    ip: '127.0.0.1',
  };
  const result = await service.create(req, 'employees', {
    employee_code: 'E-1',
    name: 'A',
  });
  assert.deepEqual(result, { id: 'existing' });
  assert.equal(calls.length, 1);
});

test('finance journals fail closed when debits and credits do not balance', async () => {
  const req = {
    body: {
      journal_number: 'J-1',
      journal_date: '2026-01-01',
      lines: [
        { account_id: 'cash', debit: 100 },
        { account_id: 'sales', credit: 99 },
      ],
    },
    orgDb: {},
    user: { sub: 'u1' },
  };
  await assert.rejects(
    () => service.createJournal(req, req.body),
    /must balance/,
  );
});

test('domain writes commit the audit and idempotency record together', async () => {
  const calls = [];
  const tx = {
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
  };
  const req = {
    body: { employee_code: 'E-2', name: 'B' },
    orgDb: {
      async transaction() {
        return tx;
      },
      async query(sql) {
        calls.push(sql);
        if (sql.startsWith('SELECT response_json')) return [[]];
        return [[]];
      },
    },
    get: () => 'create-e2',
    user: { sub: 'u1' },
    ip: '127.0.0.1',
  };
  const result = await service.create(req, 'employees', req.body);
  assert.equal(result.employee_code, 'E-2');
  assert.ok(calls.some((sql) => sql.startsWith('INSERT INTO activity_log')));
  assert.ok(
    calls.some((sql) => sql.startsWith('INSERT INTO domain_idempotency')),
  );
  assert.ok(calls.includes('commit'));
});
