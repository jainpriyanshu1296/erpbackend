const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TABLES,
  assert: validate,
  write,
  compareQuotations,
  actOnApproval,
  allocatePayment,
} = require('../src/services/zeroGapClosure.service');

test('zero-gap resources have explicit table mappings and validation is fail-closed', () => {
  assert.equal(TABLES.approval, 'approval_requests');
  assert.equal(TABLES.scrap, 'production_scrap');
  assert.throws(() => validate(false, 'required'), /required/);
});

test('closure write is transactional and includes an idempotency result', async () => {
  const calls = [];
  const tx = {
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
  };
  const db = {
    async transaction() {
      return tx;
    },
    async query(sql, options) {
      calls.push(sql);
      if (sql.startsWith('SELECT result_json')) return [[]];
      if (sql.startsWith('INSERT INTO audit_events')) return [[]];
      return [[]];
    },
  };
  const result = await write(
    db,
    'enquiry',
    { enquiry_number: 'ENQ-1', status: 'open' },
    'user-1',
    'enq:1',
  );
  assert.equal(result.enquiry_number, 'ENQ-1');
  assert.ok(result.id);
  assert.ok(calls.includes('commit'));
});

test('quotation comparison is ordered for deterministic supplier selection', async () => {
  const db = {
    async query() {
      return [
        [
          { item_id: 'item-1', unit_price: 10 },
          { item_id: 'item-1', unit_price: 12 },
        ],
      ];
    },
  };
  const rows = await compareQuotations(db, 'rfq-1');
  assert.deepEqual(
    rows.map((row) => row.unit_price),
    [10, 12],
  );
});

test('final approval step closes the request and enforces the approver role', async () => {
  const calls = [];
  const tx = {
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
  };
  const db = {
    async transaction() {
      return tx;
    },
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT * FROM approval_requests'))
        return [[{ id: 'a1', status: 'pending' }]];
      if (sql.startsWith('SELECT * FROM approval_steps'))
        return [[{ id: 's1', status: 'pending', approver_role: 'finance' }]];
      return [[]];
    },
  };
  const result = await actOnApproval(db, 'a1', 'approved', 'u1', 'finance');
  assert.equal(result.status, 'approved');
  assert.ok(calls.includes('commit'));
  await assert.rejects(
    () => actOnApproval(db, 'a1', 'approved', 'u1', 'sales'),
    /not an approver/,
  );
});

test('payment allocation cannot exceed the remaining invoice balance', async () => {
  const tx = { commit: async () => {}, rollback: async () => {} };
  const db = {
    async transaction() {
      return tx;
    },
    async query(sql) {
      if (sql.startsWith('SELECT total_amount'))
        return [[{ total_amount: 100, balance_amount: 100 }]];
      if (sql.startsWith('SELECT COALESCE(SUM(allocated_amount)'))
        return [[{ total: 0 }]];
      if (sql.startsWith('SELECT COALESCE(SUM(amount)'))
        return [[{ total: 0 }]];
      return [[]];
    },
  };
  await assert.rejects(
    () => allocatePayment(db, 'p1', 'i1', 101, 'u1'),
    /exceeds invoice balance/,
  );
});
