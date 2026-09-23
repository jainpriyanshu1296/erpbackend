const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvoice, salesOrderId, priceLines, assertFullyDispatched } = require('../src/services/invoice.service');
test('partial dispatch cannot authorize full invoicing including repeated item lines', () => {
  const order = [{ item_id: 'a', quantity: 4 }, { item_id: 'a', quantity: 6 }];
  assert.throws(() => assertFullyDispatched(order, [{ item_id: 'a', quantity: 6 }]), /All order quantities/);
  assert.doesNotThrow(() => assertFullyDispatched(order, [{ item_id: 'a', quantity: 10 }]));
  assert.throws(() => assertFullyDispatched(order, [{ item_id: 'b', quantity: 10 }]), /All order quantities/);
});
test('conflicting legacy and canonical order identities fail closed', () => {
  assert.throws(() => salesOrderId({ so_id: 'a', order_id: 'b' }), /Conflicting/);
  assert.equal(salesOrderId({ so_id: 'a', sales_order_id: 'a' }), 'a');
});
test('invoice money rejects nonfinite inputs and preserves zero GST', () => {
  assert.throws(() => priceLines([{ item_id: 'a', quantity: NaN, rate: 1 }], false), /Invalid/);
  const [line] = priceLines([{ item_id: 'a', quantity: 2, rate: 100, gst_rate: 0 }], false);
  assert.equal(line.total, 200);
  assert.equal(line.cgst, 0);
});
test('retry returns the existing invoice without inserting header or lines', async () => {
  const calls = []; let committed = false;
  const db = {
    transaction: async () => ({ commit: async () => { committed = true; }, rollback: async () => {} }),
    query: async sql => {
      calls.push(sql);
      if (sql.includes('FROM sales_orders')) return [[{ id: 'so', customer_id: 'c', status: 'delivered' }]];
      if (sql.includes('FROM invoices')) return [[{ id: 'inv', customer_id: 'c', so_id: 'so' }]];
      throw Error('Unexpected query');
    }
  };
  const result = await createInvoice(db, { so_id: 'so' }, 'u');
  assert.equal(result.id, 'inv');
  assert.equal(result.already_created, true);
  assert.equal(committed, true);
  assert.equal(calls.some(sql => sql.startsWith('INSERT')), false);
});
test('wrong customer cannot replay an order invoice', async () => {
  let rollback = false;
  const db = { transaction: async () => ({ commit: async () => {}, rollback: async () => { rollback = true; } }), query: async () => [[{ id: 'so', customer_id: 'owner', status: 'delivered' }]] };
  await assert.rejects(createInvoice(db, { so_id: 'so', customer_id: 'other' }, 'u'), /Customer does not own/);
  assert.equal(rollback, true);
});
