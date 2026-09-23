const test = require('node:test');
const assert = require('node:assert/strict');
const { transition, dispatch, transitionJobCard, calculateMRP, resolveOutputQuantity } = require('../src/services/salesProduction.service');

function fakeDb(mode = 'sales') {
  const state = { status: 'draft', effect: false, qty: 10, ledger: 0 };
  const db = {
    async transaction() {
      return { commit: async () => {}, rollback: async () => {} };
    },
    async query(sql) {
      if (sql.startsWith('SELECT id,status FROM quotations')) return [[{ id: 'q1', status: state.status }]];
      if (sql.startsWith('UPDATE quotations')) { state.status = 'sent'; return [[]]; }
      if (sql.startsWith('SELECT id,status FROM work_orders')) return [[{ id: 'w1', status: state.status }]];
      if (sql.startsWith('UPDATE work_orders')) { state.status = 'released'; return [[]]; }
      if (sql.startsWith('INSERT INTO activity_log')) return [[]];
      if (sql.startsWith('SELECT id,status,warehouse_id,so_id,customer_id FROM delivery_challans')) return [[{ id: 'd1', status: 'draft', warehouse_id: 'w1' }]];
      if (sql.startsWith('SELECT id FROM dispatch_effects')) return [state.effect ? [{ id: 'effect' }] : []];
      if (sql.startsWith('SELECT id,item_id,quantity,order_item_id FROM delivery_challan_items')) return [[{ id: 'di1', item_id: 'i1', quantity: 2 }]];
      if (sql.startsWith('SELECT current_qty,avg_rate')) return [[{ current_qty: state.qty, avg_rate: 5 }]];
      if (sql.startsWith('UPDATE stock_summary')) { state.qty -= 2; return [[]]; }
      if (sql.startsWith('INSERT INTO stock_ledger')) { state.ledger += 1; return [[]]; }
      if (sql.startsWith('INSERT INTO dispatch_effects')) { state.effect = true; return [[]]; }
      if (sql.startsWith('UPDATE delivery_challans')) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  return { db, state };
}

test('sales transition is tenant-scoped through the supplied organization database', async () => {
  const { db, state } = fakeDb();
  const result = await transition(db, 'quotations', 'q1', 'sent', 'user-1');
  assert.deepEqual(result, { id: 'q1', status: 'sent' });
  assert.equal(state.status, 'sent');
});

test('invalid production/sales transitions are rejected', async () => {
  const { db } = fakeDb();
  await assert.rejects(() => transition(db, 'quotations', 'q1', 'paid', 'user-1'), /Cannot transition/);
});

test('production transition uses the same guarded workflow primitive', async () => {
  const { db, state } = fakeDb('production');
  const result = await transition(db, 'work_orders', 'w1', 'released', 'user-1');
  assert.deepEqual(result, { id: 'w1', status: 'released' });
  assert.equal(state.status, 'released');
});

test('dispatch stock effect is idempotent', async () => {
  const { db, state } = fakeDb();
  const first = await dispatch(db, 'd1', 'w1', 'user-1');
  const second = await dispatch(db, 'd1', 'w1', 'user-1');
  assert.equal(first.already_applied, false);
  assert.equal(second.already_applied, true);
  assert.equal(state.ledger, 1);
  assert.equal(state.qty, 8);
});

test('job card rejects invalid state transitions', async () => {
  const db = {
    async transaction() { return { commit: async () => {}, rollback: async () => {} }; },
    async query(sql) {
      if (sql.startsWith('SELECT id,status FROM job_cards')) return [[{ id: 'jc1', status: 'queued' }]];
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  await assert.rejects(() => transitionJobCard(db, 'jc1', 'completed', 'user-1'), /Cannot transition job card/);
});

test('material requirements calculation is deterministic and never negative', () => {
  assert.equal(calculateMRP(100, 20, 30, 5), 55);
  assert.equal(calculateMRP(10, 20, 0, 0), 0);
  assert.throws(() => calculateMRP(-1, 0), /non-negative/);
});

test('production output normalizes decimal strings and rejects invalid or excessive quantities', () => {
  assert.equal(resolveOutputQuantity('0.000', '10.000', '4.500'), 4.5);
  assert.equal(resolveOutputQuantity('3.000', '10.000', '4.500'), 3);
  assert.throws(() => resolveOutputQuantity('0.000', '10.000', '0.000'), /positive/);
  assert.throws(() => resolveOutputQuantity('0.000', '10.000', '11.000'), /cannot exceed/);
  assert.throws(() => resolveOutputQuantity('not-a-number', '10.000', 'not-a-number'), /positive/);
});
