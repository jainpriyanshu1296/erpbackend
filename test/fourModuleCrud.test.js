const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/fourModuleCrud.service');
const { resources } = require('../src/modules/fourModuleResources');

function fixture({
  status = 'draft',
  failAudit = false,
  dependency = false,
  inactive = false,
} = {}) {
  let state = {
    order: {
      id: 'order',
      status,
      vendor_id: 'vendor',
      warehouse_id: 'wh',
      notes: 'before',
    },
    items: [
      { id: 'line', order_id: 'order', item_id: 'rm', quantity: 2, rate: 5 },
    ],
    audits: [],
  };
  const db = {
    async transaction(work) {
      const before = structuredClone(state);
      const tx = { active: true };
      try {
        return await work(tx);
      } catch (error) {
        state = before;
        throw error;
      } finally {
        tx.active = false;
      }
    },
    async query(sql, options = {}) {
      const args = options.replacements || [];
      assert.equal(options.transaction?.active, true, sql);
      if (sql.startsWith('SELECT * FROM purchase_orders'))
        return [[structuredClone(state.order)]];
      if (sql.startsWith('SELECT * FROM purchase_order_items'))
        return [structuredClone(state.items)];
      if (sql.startsWith('SELECT id FROM grn'))
        return [dependency ? [{ id: 'grn' }] : []];
      if (sql.startsWith('SELECT id FROM related_documents')) return [[]];
      if (sql.startsWith('SELECT id FROM item_master'))
        return [inactive ? [] : [{ id: args[0] }]];
      if (
        sql.startsWith('SELECT id FROM vendors') ||
        sql.startsWith('SELECT id FROM warehouses')
      )
        return [[{ id: args[0] }]];
      if (sql.startsWith('UPDATE purchase_order_items')) {
        const keys = sql
          .match(/SET (.+) WHERE/)[1]
          .split(',')
          .map((value) => value.split('=')[0]);
        const row = state.items.find((row) => row.id === args.at(-2));
        keys.forEach((key, index) => (row[key] = args[index]));
        return [[]];
      }
      if (sql.startsWith('INSERT INTO purchase_order_items')) {
        const keys = sql.match(/\((.+)\) VALUES/)[1].split(',');
        state.items.push(
          Object.fromEntries(keys.map((key, index) => [key, args[index]])),
        );
        return [[]];
      }
      if (sql.startsWith('DELETE FROM purchase_order_items')) {
        state.items = sql.includes('WHERE id=')
          ? state.items.filter((row) => row.id !== args[0])
          : [];
        return [[]];
      }
      if (sql.startsWith('UPDATE purchase_orders')) {
        const keys = sql
          .match(/SET (.+) WHERE/)[1]
          .split(',')
          .map((value) => value.split('=')[0]);
        keys.forEach((key, index) => (state.order[key] = args[index]));
        return [[]];
      }
      if (sql.startsWith('DELETE FROM purchase_orders')) {
        state.order = null;
        return [[]];
      }
      if (sql.startsWith('INSERT INTO audit_events')) {
        if (failAudit) throw new Error('Audit failed');
        state.audits.push(args);
        return [[]];
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
  return { req: { orgDb: db, user: { sub: 'admin' } }, state: () => state };
}
test('header and line updates preserve identity and recalculate purchase total in one transaction', async () => {
  const f = fixture();
  await service.update(f.req, '/purchase/orders', 'order', {
    notes: 'after',
    items: [
      {
        id: 'line',
        item_id: 'rm',
        quantity: '3',
        rate: '8',
        discount_percent: 10,
        tax_percent: 18,
      },
    ],
  });
  assert.equal(f.state().items[0].id, 'line');
  assert.equal(f.state().items[0].quantity, 3);
  assert.equal(f.state().order.total_amount, 25.49);
  assert.equal(f.state().order.notes, 'after');
  assert.equal(f.state().audits.length, 1);
});
test('audit failure rolls back header, item changes and totals', async () => {
  const f = fixture({ failAudit: true });
  const before = structuredClone(f.state());
  await assert.rejects(
    service.update(f.req, '/purchase/orders', 'order', {
      notes: 'after',
      items: [{ id: 'line', item_id: 'rm', quantity: 3, rate: 8 }],
    }),
    /Audit failed/,
  );
  assert.deepEqual(f.state(), before);
});
test('line CRUD reuses parent lock, keeps other lines, and refuses deleting the final line', async () => {
  const f = fixture();
  await service.mutateLine(f.req, '/purchase/orders', 'order', null, 'POST', {
    item_id: 'rm',
    quantity: 1,
    rate: 9,
  });
  assert.equal(f.state().items.length, 2);
  assert.equal(f.state().items[0].id, 'line');
  await service.mutateLine(
    f.req,
    '/purchase/orders',
    'order',
    'line',
    'PATCH',
    { quantity: 4 },
  );
  assert.equal(f.state().items[0].quantity, 4);
  await service.mutateLine(
    f.req,
    '/purchase/orders',
    'order',
    'line',
    'DELETE',
  );
  assert.equal(f.state().items.length, 1);
  await assert.rejects(
    service.mutateLine(
      f.req,
      '/purchase/orders',
      'order',
      f.state().items[0].id,
      'DELETE',
    ),
    /between 1 and 500/,
  );
});
test('a foreign child id or inactive item cannot be injected into a document', async () => {
  const f = fixture();
  await assert.rejects(
    service.update(f.req, '/purchase/orders', 'order', {
      items: [{ id: 'foreign', item_id: 'rm', quantity: 1, rate: 1 }],
    }),
    /Invalid or repeated/,
  );
  assert.equal(f.state().items[0].id, 'line');
  const inactive = fixture({ inactive: true });
  await assert.rejects(
    service.update(inactive.req, '/purchase/orders', 'order', {
      items: [{ id: 'line', item_id: 'inactive', quantity: 1, rate: 1 }],
    }),
    /active item/,
  );
});
test('posted states and related documents reject edit and delete without writes', async () => {
  for (const options of [{ status: 'approved' }, { dependency: true }]) {
    const f = fixture(options);
    const before = structuredClone(f.state());
    await assert.rejects(
      service.update(f.req, '/purchase/orders', 'order', { notes: 'bad' }),
      { status: 409 },
    );
    await assert.rejects(service.remove(f.req, '/purchase/orders', 'order'), {
      status: 409,
    });
    assert.deepEqual(f.state(), before);
  }
});
test('draft delete removes header and children atomically and audits it', async () => {
  const f = fixture();
  await service.remove(f.req, '/purchase/orders', 'order');
  assert.equal(f.state().order, null);
  assert.equal(f.state().items.length, 0);
  assert.equal(f.state().audits.length, 1);
  const rejected = fixture({ failAudit: true });
  await assert.rejects(
    service.remove(rejected.req, '/purchase/orders', 'order'),
    /Audit failed/,
  );
  assert.equal(rejected.state().items.length, 1);
  assert.ok(rejected.state().order);
});
test('arbitrary fields, status bypass, precision loss, dates, nonfinite quantities and PPC fail closed', () => {
  for (const body of [
    { status: 'posted' },
    { quantity: Infinity },
    { quantity: 0 },
    { quantity: 0.00001 },
    { quantity: true },
    { quantity: null },
  ])
    assert.throws(() => service.clean(['quantity'], body));
  assert.throws(() =>
    service.clean(['delivery_date'], { delivery_date: '2026-02-30' }),
  );
  assert.throws(() => service.definition('/ppc/orders'), { status: 404 });
  assert.throws(() => service.definition('/inventory/ledger'), { status: 404 });
  assert.throws(() => service.definition('/inventory/stock'), { status: 404 });
  assert.ok(
    Object.values(resources).every((def) =>
      ['purchase', 'inventory', 'production', 'jobwork'].includes(def.module),
    ),
  );
});

test('invoice cancellation reverses journal and GST together and rolls back on audit failure', async () => {
  for (const failAudit of [false, true]) {
    let state = {
      invoice: {
        id: 'invoice',
        status: 'open',
        document_type: 'payable',
        paid_amount: 0,
      },
      journal: {
        id: 'journal',
        journal_number: 'J-1',
        status: 'posted',
        total_debit: 118,
      },
      reversals: [],
      taxes: [],
      audits: [],
    };
    const before = structuredClone(state);
    const db = {
      async transaction(work) {
        const tx = { active: true };
        try {
          return await work(tx);
        } catch (error) {
          state = structuredClone(before);
          throw error;
        } finally {
          tx.active = false;
        }
      },
      async query(sql, options) {
        assert.equal(options.transaction.active, true, sql);
        const a = options.replacements;
        if (sql.startsWith('SELECT * FROM finance_documents'))
          return [[{ ...state.invoice }]];
        if (
          sql.startsWith('SELECT id,status FROM finance_journals') ||
          sql.startsWith('SELECT * FROM finance_journals')
        )
          return [[{ ...state.journal }]];
        if (
          sql.startsWith('SELECT id FROM finance_journals WHERE journal_number')
        )
          return [[]];
        if (sql.startsWith('INSERT INTO finance_journals')) {
          state.reversals.push(a);
          return [[]];
        }
        if (sql.startsWith('SELECT account_id'))
          return [
            [
              { account_id: 'purchase', debit: 100, credit: 0 },
              { account_id: 'input', debit: 18, credit: 0 },
              { account_id: 'payable', debit: 0, credit: 118 },
            ],
          ];
        if (sql.startsWith('INSERT INTO finance_journal_lines')) {
          state.reversals.push(a);
          return [[]];
        }
        if (sql.startsWith('UPDATE finance_journals')) {
          state.journal.status = 'reversed';
          return [[]];
        }
        if (sql.startsWith('SELECT e.* FROM gst_ledger_entries'))
          return [
            [
              { tax_type: 'cgst', amount: 9, direction: 'debit' },
              { tax_type: 'sgst', amount: 9, direction: 'debit' },
            ],
          ];
        if (
          sql.startsWith('INSERT INTO gst_context_snapshots') ||
          sql.startsWith('INSERT INTO gst_ledger_entries')
        ) {
          state.taxes.push(a);
          return [[]];
        }
        if (sql.startsWith('UPDATE finance_documents')) {
          state.invoice.status = 'cancelled';
          return [[]];
        }
        if (sql.startsWith('INSERT INTO audit_events')) {
          if (failAudit) throw new Error('Audit failed');
          state.audits.push(a);
          return [[]];
        }
        throw new Error(sql);
      },
    };
    const req = { orgDb: db, user: { sub: 'admin' } };
    if (failAudit) {
      await assert.rejects(
        service.remove(req, '/purchase/vendor-invoices', 'invoice'),
        /Audit failed/,
      );
      assert.deepEqual(state, before);
    } else {
      await service.remove(req, '/purchase/vendor-invoices', 'invoice');
      assert.equal(state.invoice.status, 'cancelled');
      assert.equal(state.journal.status, 'reversed');
      assert.equal(state.reversals.length, 4);
      assert.equal(state.taxes.length, 3);
      assert.equal(state.taxes[1].at(-1), 'credit');
    }
  }
});
test('routing CRUD validates parent ownership, state, quantities and transaction rollback', async () => {
  const routing = require('../src/services/productionRoutingCrud.service');
  let state = {
    work: { id: 'wo', status: 'released', planned_qty: 10 },
    operation: {
      id: 'op',
      wo_id: 'wo',
      status: 'pending',
      completed_qty: 0,
      rejected_qty: 0,
    },
    audits: [],
  };
  let failAudit = false;
  const db = {
    async transaction(work) {
      const before = structuredClone(state);
      const tx = { active: true };
      try {
        return await work(tx);
      } catch (error) {
        state = before;
        throw error;
      } finally {
        tx.active = false;
      }
    },
    async query(sql, options) {
      assert.equal(options.transaction.active, true);
      const a = options.replacements;
      if (sql.startsWith('SELECT id,status,planned_qty')) return [[state.work]];
      if (sql.startsWith('SELECT * FROM wo_routing_operations'))
        return [a[0] === 'op' && a[1] === 'wo' ? [{ ...state.operation }] : []];
      if (sql.startsWith('SELECT id FROM job_cards')) return [[]];
      if (sql.startsWith('UPDATE wo_routing_operations')) {
        const keys = sql
          .match(/SET (.+) WHERE/)[1]
          .split(',')
          .map((value) => value.split('=')[0])
          .filter((key) => !key.startsWith('actual_') && key !== 'NOW())');
        keys.forEach((key, index) => (state.operation[key] = a[index]));
        return [[]];
      }
      if (sql.startsWith('DELETE FROM wo_routing_operations')) {
        state.operation = null;
        return [[]];
      }
      if (sql.startsWith('INSERT INTO audit_events')) {
        if (failAudit) throw new Error('Audit failed');
        state.audits.push(a);
        return [[]];
      }
      throw new Error(sql);
    },
  };
  const req = { orgDb: db, user: { sub: 'admin' } };
  await assert.rejects(
    routing.mutate(req, 'wo', 'foreign', 'PATCH', { notes: 'bad' }),
    { status: 404 },
  );
  await assert.rejects(
    routing.mutate(req, 'wo', 'op', 'PATCH', { completed_qty: -1 }),
    /Invalid completed_qty/,
  );
  await assert.rejects(
    routing.mutate(req, 'wo', 'op', 'PATCH', { completed_qty: 11 }),
    /exceeds/,
  );
  await assert.rejects(
    routing.mutate(req, 'wo', 'op', 'PATCH', { status: 'completed' }),
    /Invalid operation status/,
  );
  const before = structuredClone(state);
  failAudit = true;
  await assert.rejects(
    routing.mutate(req, 'wo', 'op', 'PATCH', { notes: 'after' }),
    /Audit failed/,
  );
  assert.deepEqual(state, before);
  failAudit = false;
  await routing.mutate(req, 'wo', 'op', 'DELETE');
  assert.equal(state.operation, null);
  assert.equal(state.audits.length, 1);
});
test('settings CRUD cannot cross module namespaces and audits update and reset in one transaction', async () => {
  let state = { settings: new Map(), audits: [] };
  const db = {
    async transaction(work) {
      const before = structuredClone(state);
      const tx = { active: true };
      try {
        return await work(tx);
      } catch (error) {
        state = before;
        throw error;
      } finally {
        tx.active = false;
      }
    },
    async query(sql, options) {
      assert.equal(options.transaction.active, true);
      const a = options.replacements;
      if (sql.startsWith('INSERT INTO company_settings')) {
        state.settings.set(a[0], a[1]);
        return [[]];
      }
      if (sql.startsWith('SELECT setting_key FROM company_settings'))
        return [state.settings.has(a[0]) ? [{ setting_key: a[0] }] : []];
      if (sql.startsWith('DELETE FROM company_settings')) {
        state.settings.delete(a[0]);
        return [[]];
      }
      if (sql.startsWith('INSERT INTO audit_events')) {
        state.audits.push(a);
        return [[]];
      }
      throw new Error(sql);
    },
  };
  const req = { orgDb: db, user: { sub: 'admin' } };
  await assert.rejects(
    service.saveSetting(
      req,
      '/purchase/settings',
      'production.require_material_issue',
      { setting_value: '0' },
    ),
    /Unsupported module/,
  );
  await assert.rejects(
    service.saveSetting(req, '/purchase/settings', 'approval_required', {
      setting_value: 'yes',
    }),
    /true or false/,
  );
  await service.saveSetting(req, '/purchase/settings', 'approval_required', {
    setting_value: '1',
  });
  assert.equal(state.settings.get('purchase.approval_required'), '1');
  await service.remove(req, '/purchase/settings', 'purchase.approval_required');
  assert.equal(state.settings.size, 0);
  assert.equal(state.audits.length, 2);
});

test('CRUD delete routes enforce can_delete independently from can_edit', async () => {
  const routes = require('../src/modules/fourModuleCrud.routes')
    .stack.filter((layer) => layer.route)
    .map((layer) => layer.route);
  for (const endpoint of [
    '/purchase/orders',
    '/inventory/transfers',
    '/production/work-orders',
    '/jobwork/billing',
  ]) {
    const route = routes.find(
      (route) => route.path === `${endpoint}/:id` && route.methods.delete,
    );
    assert.ok(route);
    let advanced = false;
    let status;
    let requested;
    const req = {
      user: { role: 'staff' },
      method: 'DELETE',
      originalUrl: route.path,
      orgDb: {
        async query(sql) {
          if (sql.startsWith('SELECT')) {
            requested = sql;
            return [[{ allowed: 0 }]];
          }
          return [[]];
        },
      },
    };
    const res = {
      locals: {},
      status(value) {
        status = value;
        return this;
      },
      json(body) {
        return body;
      },
    };
    await route.stack[4].handle(req, res, () => {
      advanced = true;
    });
    assert.equal(status, 403);
    assert.equal(advanced, false);
    assert.match(requested, /SELECT can_delete/);
  }
});

test('CRUD fields and child foreign keys exist in the forward migration schema', () => {
  const fs = require('fs');
  const path = require('path');
  const directory = path.join(__dirname, '../src/migrations/org');
  const columns = new Map();
  for (const name of fs.readdirSync(directory).sort()) {
    const sql = fs.readFileSync(path.join(directory, name), 'utf8');
    for (const match of sql.matchAll(
      /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/g,
    )) {
      if (columns.has(match[1])) continue;
      columns.set(
        match[1],
        new Set(
          [
            ...match[2].matchAll(
              /^\s*(\w+)\s+(?:VARCHAR|CHAR|INT|TINYINT|TEXT|DATE|DATETIME|DECIMAL|ENUM|JSON|BIGINT|BOOLEAN|TIMESTAMP)\b/gm,
            ),
          ].map((row) => row[1]),
        ),
      );
    }
    for (const match of sql.matchAll(/ALTER TABLE\s+(\w+)\s+([\s\S]*?);/g))
      for (const row of match[2].matchAll(
        /ADD COLUMN (?:IF NOT EXISTS )?(\w+)/g,
      ))
        columns.get(match[1])?.add(row[1]);
  }
  for (const [endpoint, def] of Object.entries(resources)) {
    if (def.category) continue;
    const table = def.bill ? 'finance_documents' : def.table;
    for (const field of def.fields)
      assert.ok(
        columns.get(table)?.has(field),
        `${endpoint}: ${table}.${field}`,
      );
    if (def.children)
      for (const field of [def.children.foreignKey, ...def.children.fields])
        assert.ok(
          columns.get(def.children.table)?.has(field),
          `${endpoint}: ${def.children.table}.${field}`,
        );
  }
});

test('physical count detail does not shadow the existing counted-items list', async () => {
  const router = require('../src/modules/fourModuleCrud.routes');
  const route = router.stack.find(
    (layer) =>
      layer.route?.path === '/closure/physical-counts/:id' &&
      layer.route.methods.get,
  ).route;
  let passed = false;
  await route.stack.at(-1).handle({ params: { id: 'lines' } }, {}, () => {
    passed = true;
  });
  assert.equal(passed, true);
});
