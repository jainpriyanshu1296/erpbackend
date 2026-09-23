const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/modules/inventoryPurchase.service');

test('purchase order transition rejects an invalid status jump', async () => {
  const db = {
    query: async (sql) => sql.startsWith('SELECT id,status') ? [[{ id: 'po-1', status: 'draft' }]] : [],
    transaction: async fn => fn({})
  };
  const result = await service.transition(db, 'purchase_orders', 'po-1', 'posted', 'u-1');
  assert.equal(result.error, 'INVALID_TRANSITION');
  assert.equal(result.current, 'draft');
});

test('GRN posting awaits Incoming QC without crediting stock and is idempotent', async () => {
  let status = 'draft';
  const ledger = []; const summary = [];
  const db = {
    query: async (sql, options = {}) => {
      if (sql.startsWith('SELECT * FROM grn_items')) return [[{ item_id: 'item-1', quantity: 3, rate: 10 }]];
      if (sql.startsWith('SELECT * FROM grn')) return [[{ id: 'grn-1', status, warehouse_id: 'wh-1' }]];
      if (sql.startsWith('SELECT id FROM warehouses') || sql.startsWith('SELECT id FROM item_master')) return [[{id:'active'}]];
      if (sql.startsWith('INSERT INTO stock_ledger')) { ledger.push(options.replacements); return []; }
      if (sql.startsWith('INSERT INTO stock_summary')) { summary.push(options.replacements); return []; }
      if (sql.startsWith('UPDATE grn')) { status = 'posted'; return []; }
      return [];
    },
    transaction: async fn => fn({})
  };
  const posted = await service.postGrn(db, 'grn-1', 'u-1');
  assert.equal(posted.status, 'posted');
  assert.equal(posted.awaiting_qc, true);
  assert.equal(ledger.length, 0);
  assert.equal(summary.length, 0);
  const duplicate = await service.postGrn(db, 'grn-1', 'u-1');
  assert.equal(duplicate.already_posted, true);
  assert.equal(ledger.length, 0);
});

test('warehouse transfer receipt is idempotent', async () => {
  let received = false; let ledgerWrites = 0;
  const db = {
    query: async (sql) => {
      if (sql.startsWith('SELECT * FROM warehouse_transfers')) return [[{ id: 't-1', status: received ? 'received' : 'in_transit', from_warehouse_id: 'a', to_warehouse_id: 'b' }]];
      if (sql.startsWith('SELECT id FROM warehouse_transfer_receipts')) return [received ? [{ id: 'r-1' }] : []];
      if (sql.startsWith('SELECT * FROM warehouse_transfer_items')) return [[{ item_id: 'i-1', quantity: 2, rate: 5 }]];
      if (sql.startsWith('SELECT current_qty,avg_rate FROM stock_summary')) return [[{ current_qty: 10, avg_rate: 5 }]];
      if (sql.startsWith('INSERT INTO stock_ledger')) ledgerWrites += 1;
      if (sql.startsWith('INSERT INTO warehouse_transfer_receipts')) received = true;
      return [];
    }, transaction: async fn => fn({})
  };
  assert.equal((await service.receiveTransfer(db, 't-1', 'u-1')).status, 'received');
  assert.equal((await service.receiveTransfer(db, 't-1', 'u-1')).alreadyReceived, true);
  assert.equal(ledgerWrites, 2);
});

test('reservation refuses to exceed available stock', async () => {
  const db = {
    query: async (sql) => {
      if (sql.startsWith('SELECT current_qty')) return [[{ current_qty: 5 }]];
      if (sql.startsWith('SELECT quantity FROM stock_reservations')) return [[{ quantity: 4 }]];
      return [];
    }, transaction: async fn => fn({})
  };
  const result = await service.reserveStock(db, { item_id: 'i-1', warehouse_id: 'w-1', quantity: 2 }, 'u-1');
  assert.equal(result.error, 'INSUFFICIENT_AVAILABLE_STOCK');
});

test('RFQ transition uses the explicit comparison and selection workflow', async () => {
  const db = {
    query: async (sql) => sql.startsWith('SELECT * FROM rfqs') ? [[{ id: 'r-1', status: 'quoted' }]] : [],
    transaction: async fn => fn({})
  };
  assert.equal((await service.transitionRfq(db, 'r-1', 'compared', 'u-1')).status, 'compared');
});
