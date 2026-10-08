const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/operationalDomains.service');

function fixture({ failAudit = false, failBillLink = false } = {}) {
  let state = {
    order: {
      id: 'order',
      status: 'approved',
      order_type: 'customer',
      customer_id: 'customer',
      warehouse_id: 'wh',
      item_id: 'item',
      quantity: 10,
    },
    stock: { current_qty: 20, avg_rate: 5, total_value: 100 },
    documents: [],
    effects: [],
    ledger: [],
    audits: [],
    replay: new Map(),
  };
  const db = {
    async transaction(work) {
      assert.equal(
        typeof work,
        'function',
        'Job Work should own one managed transaction',
      );
      const original = structuredClone(state);
      const tx = { active: true };
      try {
        const result = await work(tx);
        tx.active = false;
        return result;
      } catch (error) {
        state = original;
        tx.active = false;
        throw error;
      }
    },
    async query(sql, options = {}) {
      const args = options.replacements || [];
      if (sql.startsWith('SELECT setting_key')) return [[]];
      assert.equal(
        options.transaction?.active,
        true,
        `Query must share the document transaction: ${sql}`,
      );
      if (sql.startsWith('INSERT INTO domain_idempotency')) {
        const key = `${args[1]}:${args[2]}`;
        if (!state.replay.has(key)) state.replay.set(key, 'null');
        return [[]];
      }
      if (sql.startsWith('SELECT response_json'))
        return [[{ response_json: state.replay.get(`${args[0]}:${args[1]}`) }]];
      if (sql.startsWith('UPDATE domain_idempotency')) {
        state.replay.set(`${args[1]}:${args[2]}`, args[0]);
        return [[]];
      }
      if (
        sql.startsWith('SELECT * FROM job_work_orders') ||
        sql.startsWith('SELECT id,order_type')
      )
        return [[{ ...state.order }]];
      if (
        sql.startsWith('SELECT id FROM warehouses') ||
        sql.startsWith('SELECT id FROM item_master') ||
        sql.startsWith('SELECT id FROM customers') ||
        sql.startsWith('SELECT id FROM vendors')
      )
        return [[{ id: args[0] }]];
      if (sql.includes('FROM job_work_challan_items ci'))
        return [[{ quantity: 0 }]];
      if (sql.startsWith('SELECT id FROM stock_effects'))
        return [state.effects.filter((row) => row[1] === args[0])];
      if (sql.startsWith('SELECT current_qty')) return [[{ ...state.stock }]];
      if (sql.includes('INSERT INTO stock_summary')) {
        state.stock = {
          current_qty: args[2],
          avg_rate: args[3],
          total_value: args[4],
        };
        return [[]];
      }
      if (sql.startsWith('INSERT INTO stock_effects')) {
        state.effects.push(args);
        return [[]];
      }
      if (sql.startsWith('INSERT INTO stock_ledger')) {
        state.ledger.push(args);
        return [[]];
      }
      if (sql.startsWith('INSERT INTO activity_log')) {
        if (failAudit) throw new Error('audit unavailable');
        state.audits.push(args);
        return [[]];
      }
      if (sql.startsWith('INSERT INTO job_work_bills') && failBillLink)
        throw new Error('bill link unavailable');
      if (sql.startsWith('INSERT INTO')) {
        state.documents.push({ sql, args });
        return [[]];
      }
      if (sql.startsWith('UPDATE job_work_orders')) {
        state.order.status = 'sent';
        return [[]];
      }
      throw new Error(`Unhandled query: ${sql}`);
    },
  };
  const req = {
    orgDb: db,
    user: { sub: 'user' },
    ip: '127.0.0.1',
    body: { idempotency_key: 'retry' },
    get: () => null,
  };
  return { req, state: () => state };
}
const outward = {
  job_work_order_id: 'order',
  challan_number: 'CH-1',
  warehouse_id: 'wh',
  items: [{ item_id: 'item', quantity: 2 }],
};

test('Job Work retry returns the original challan without repeating stock, ledger or audit', async () => {
  const { req, state } = fixture();
  const first = await service.issueJobWorkChallan(req, outward);
  const second = await service.issueJobWorkChallan(req, outward);
  assert.deepEqual(second, first);
  assert.equal(state().stock.current_qty, 18);
  assert.equal(state().stock.total_value, 90);
  assert.equal(state().effects.length, 1);
  assert.equal(state().ledger.length, 1);
  assert.equal(state().audits.length, 1);
});

test('Job Work audit failure rolls back header, stock, ledger, effect and replay reservation', async () => {
  const { req, state } = fixture({ failAudit: true });
  await assert.rejects(
    service.issueJobWorkChallan(req, outward),
    /audit unavailable/,
  );
  assert.equal(state().stock.current_qty, 20);
  assert.equal(state().documents.length, 0);
  assert.equal(state().effects.length, 0);
  assert.equal(state().ledger.length, 0);
  assert.equal(state().replay.size, 0);
  assert.equal(state().order.status, 'approved');
});

test('Job Work billing link failure rolls back its finance document and replay reservation', async () => {
  const { req, state } = fixture({ failBillLink: true });
  await assert.rejects(
    service.createJobWorkBill(req, {
      job_work_order_id: 'order',
      document_number: 'BILL-1',
      document_date: '2026-10-08',
      amount: 20,
    }),
    /bill link unavailable/,
  );
  assert.equal(state().documents.length, 0);
  assert.equal(state().replay.size, 0);
});

test('Job Work rejects invalid replay keys before mutation', async () => {
  const { req, state } = fixture();
  req.body.idempotency_key = 'x'.repeat(151);
  await assert.rejects(
    service.issueJobWorkChallan(req, outward),
    /Idempotency key/,
  );
  assert.equal(state().documents.length, 0);
});
