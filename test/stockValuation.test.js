const test = require('node:test');
const assert = require('node:assert/strict');
const { applyStockEffect } = require('../src/services/zeroGapClosure.service');
const { transition } = require('../src/services/salesProduction.service');

function stockDb() {
  const state = { current_qty: 10, avg_rate: 5, total_value: 50 };
  let ledger;
  const db = {
    async transaction() {
      return { commit: async () => {}, rollback: async () => {} };
    },
    async query(sql, { replacements } = {}) {
      if (sql.startsWith('SELECT id FROM stock_effects')) return [[]];
      if (sql.startsWith('SELECT current_qty')) return [[{ ...state }]];
      if (sql.includes('INSERT INTO stock_summary')) {
        Object.assign(state, {
          current_qty: replacements[2],
          avg_rate: replacements[3],
          total_value: replacements[4],
        });
      }
      if (sql.startsWith('INSERT INTO stock_ledger')) ledger = replacements;
      return [[]];
    },
  };
  return { db, state, ledger: () => ledger };
}
const context = {
  operationKey: 'effect',
  referenceType: 'job_work_receipt',
  referenceId: 'receipt',
  itemId: 'item',
  warehouseId: 'warehouse',
  quantity: 2,
};

test('outgoing stock uses carrying cost even when the caller supplies a selling price', async () => {
  const { db, state, ledger } = stockDb();
  await applyStockEffect(db, { ...context, direction: 'out', rate: 100 });
  assert.equal(state.total_value, 40);
  assert.equal(state.avg_rate, 5);
  assert.equal(ledger()[9], 5);
  assert.equal(ledger()[10], 10);
});

test('incoming stock preserves an explicit zero cost and recalculates weighted average', async () => {
  const { db, state, ledger } = stockDb();
  await applyStockEffect(db, { ...context, direction: 'in', rate: 0 });
  assert.equal(state.current_qty, 12);
  assert.equal(state.total_value, 50);
  assert.equal(state.avg_rate, 50 / 12);
  assert.equal(ledger()[9], 0);
  assert.equal(ledger()[10], 0);
});

test('invalid stock directions and rates fail before opening a transaction', async () => {
  const db = {
    transaction: () => {
      throw new Error('unexpected database access');
    },
  };
  await assert.rejects(
    applyStockEffect(db, { ...context, direction: 'invalid' }),
    /direction/,
  );
  for (const rate of [-1, Infinity, 'bad']) {
    await assert.rejects(
      applyStockEffect(db, { ...context, direction: 'in', rate }),
      /rate/,
    );
  }
});

test('cancelling a work order with issued materials fails without changing status', async () => {
  let updated = false;
  const db = {
    async transaction() {
      return { commit: async () => {}, rollback: async () => {} };
    },
    async query(sql) {
      if (sql.startsWith('SELECT id,status FROM work_orders'))
        return [[{ id: 'wo', status: 'in_progress' }]];
      if (sql.startsWith('SELECT id FROM material_issue_effects'))
        return [[{ id: 'issue' }]];
      if (sql.startsWith('UPDATE')) updated = true;
      return [[]];
    },
  };
  await assert.rejects(
    transition(db, 'work_orders', 'wo', 'cancelled', 'user'),
    /materials must be reversed/,
  );
  assert.equal(updated, false);
});

test('production completion transfers issued material cost into finished stock exactly once', async () => {
  const {
    completeWorkOrder,
  } = require('../src/services/salesProduction.service');
  let applied = false;
  let stock;
  let ledger;
  const db = {
    async transaction() {
      return { commit: async () => {}, rollback: async () => {} };
    },
    async query(sql, { replacements }) {
      if (sql.startsWith('SELECT w.*'))
        return [
          [
            {
              id: 'wo',
              bom_id: 'bom',
              finished_item_id: 'fg',
              planned_qty: 5,
              produced_qty: 0,
              status: 'in_progress',
            },
          ],
        ];
      if (sql.startsWith('SELECT id FROM production_effects'))
        return [applied ? [{ id: 'effect' }] : []];
      if (sql.startsWith('SELECT rd.source_id'))
        return [
          [
            {
              source_id: 'po',
              status: 'released',
              bom_id: 'bom',
              item_id: 'fg',
              planned_qty: 5,
            },
          ],
        ];
      if (sql.startsWith('SELECT id FROM material_issue_effects'))
        return [[{ id: 'issue' }]];
      if (sql.startsWith('SELECT current_qty'))
        return [[{ current_qty: 10, avg_rate: 4, total_value: 40 }]];
      if (sql.startsWith('SELECT COALESCE(SUM(amount)'))
        return [[{ material_cost: 30 }]];
      if (sql.startsWith('INSERT INTO stock_summary')) stock = replacements;
      if (sql.startsWith('INSERT INTO stock_ledger')) ledger = replacements;
      if (sql.startsWith('INSERT INTO production_effects')) applied = true;
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) return [[]];
      throw new Error(`Unhandled query ${sql}`);
    },
  };
  const first = await completeWorkOrder(db, 'wo', 'wh', 'user');
  assert.equal(first.already_applied, false);
  assert.deepEqual(stock.slice(2, 5), [15, 70 / 15, 70]);
  assert.deepEqual(ledger.slice(8, 10), [6, 30]);
  const original = stock;
  const second = await completeWorkOrder(db, 'wo', 'wh', 'user');
  assert.equal(second.already_applied, true);
  assert.equal(stock, original);
});

test('challan cancellation restores original ledger cost after carrying average changes', async () => {
  const {
    cancelJobWorkStockDocument,
  } = require('../src/services/operationalDomains.service');
  for (const originalValue of [50, 0]) {
    const { db, state, ledger } = stockDb();
    Object.assign(state, { current_qty: 90, avg_rate: 8, total_value: 720 });
    const query = db.query;
    db.query = async (sql, options) => {
      if (sql.startsWith('SELECT * FROM job_work_challans'))
        return [
          [
            {
              id: 'challan',
              status: 'posted',
              warehouse_id: 'warehouse',
              job_work_order_id: 'order',
            },
          ],
        ];
      if (sql.includes('SELECT COUNT(*) FROM job_work_receipts'))
        return [[{ total: 0 }]];
      if (sql.startsWith('SELECT item_id,quantity FROM job_work_challan_items'))
        return [[{ item_id: 'item', quantity: 10 }]];
      if (sql.startsWith('SELECT qty_out,amount FROM stock_ledger'))
        return [[{ qty_out: 10, amount: originalValue }]];
      return query(sql, options);
    };
    await cancelJobWorkStockDocument(
      { orgDb: db, user: { sub: 'user' } },
      'challan',
      'challan',
    );
    assert.equal(state.current_qty, 100);
    assert.equal(state.total_value, 720 + originalValue);
    assert.equal(ledger()[9], originalValue / 10);
  }
});

test('challan cancellation refuses inconsistent original stock ledger without changing stock', async () => {
  const {
    cancelJobWorkStockDocument,
  } = require('../src/services/operationalDomains.service');
  const { db, state } = stockDb();
  const query = db.query;
  db.query = async (sql, options) => {
    if (sql.startsWith('SELECT * FROM job_work_challans'))
      return [[{ id: 'challan', status: 'posted', warehouse_id: 'warehouse' }]];
    if (sql.includes('SELECT COUNT(*) FROM job_work_receipts'))
      return [[{ total: 0 }]];
    if (sql.startsWith('SELECT item_id,quantity FROM job_work_challan_items'))
      return [[{ item_id: 'item', quantity: 10 }]];
    if (sql.startsWith('SELECT qty_out,amount FROM stock_ledger'))
      return [[{ qty_out: 9, amount: 45 }]];
    return query(sql, options);
  };
  await assert.rejects(
    cancelJobWorkStockDocument({ orgDb: db }, 'challan', 'challan'),
    /valuation is missing or inconsistent/,
  );
  assert.deepEqual(state, { current_qty: 10, avg_rate: 5, total_value: 50 });
});
