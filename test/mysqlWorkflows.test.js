const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const http = require('node:http');
const { Sequelize } = require('sequelize');
const { applyMigrationsToDb } = require('../src/migrations/run');

// Opt in with a disposable local MySQL server; never use tenant credentials.
test(
  'fresh MySQL migrations and four-module HTTP workflows',
  { skip: !process.env.ERP_TEST_MYSQL_PORT, timeout: 120000 },
  async (t) => {
    const port = Number(process.env.ERP_TEST_MYSQL_PORT);
    const suffix = `${process.pid}_${Date.now()}`;
    const masterName = `erp_test_master_${suffix}`;
    const tenantName = `erp_test_org_${suffix}`;
    process.env.MASTER_DB_HOST = '127.0.0.1';
    process.env.MASTER_DB_PORT = String(port);
    process.env.MASTER_DB_USER = 'root';
    process.env.MASTER_DB_PASS = '';
    process.env.MASTER_DB_NAME = masterName;
    process.env.JWT_SECRET = 'disposable-integration-test-secret-32chars';
    process.env.PLATFORM_DOMAIN = 'erp.test';
    const connection = await mysql.createConnection({
      host: '127.0.0.1',
      port,
      user: 'root',
    });
    const db = new Sequelize(tenantName, 'root', '', {
      host: '127.0.0.1',
      port,
      dialect: 'mysql',
      logging: false,
    });
    let server;
    t.after(async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
      await require('../src/config/orgDb').closeOrgDbs();
      await require('../src/config/db').close();
      await db.close();
      await connection.query(`DROP DATABASE IF EXISTS \`${tenantName}\``);
      await connection.query(`DROP DATABASE IF EXISTS \`${masterName}\``);
      await connection.end();
    });
    await connection.query(`CREATE DATABASE \`${tenantName}\``);
    await applyMigrationsToDb(connection, masterName, 'master');
    await applyMigrationsToDb(connection, tenantName, 'org');
    await applyMigrationsToDb(connection, tenantName, 'org');
    await connection.query(`USE \`${masterName}\``);
    await connection.query(
      "INSERT INTO organizations(id,slug,db_name,company_name,owner_email,plan,is_trial,status) VALUES('org','acme',?,'Test','test@example.test','pro',0,'active')",
      [tenantName],
    );
    await connection.query(
      "INSERT INTO organization_domains(id,organization_id,hostname,subdomain,is_active) VALUES('domain','org','acme.erp.test','acme',1)",
    );
    await connection.query(
      "INSERT INTO subscriptions(id,org_id,plan,duration_months,amount,status) VALUES('subscription','org','pro',1,1,'active')",
    );
    await db.query(
      "INSERT INTO users(id,name,email,password_hash,role) VALUES('admin','Test','admin@example.test','unused','admin')",
    );
    await db.query(
      "INSERT INTO warehouses(id,warehouse_code,warehouse_name) VALUES('wh','WH','Warehouse'),('wh2','WH2','Warehouse 2')",
    );
    await db.query(
      "INSERT INTO item_master(id,item_code,item_name) VALUES('rm','RM','Raw'),('fg','FG','Finished')",
    );
    await db.query(
      "INSERT INTO vendors(id,vendor_code,company_name) VALUES('vendor','V','Vendor')",
    );
    await db.query(
      "INSERT INTO customers(id,customer_code,company_name) VALUES('customer','C','Customer')",
    );
    await db.query(
      "INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value) VALUES('rm','wh',100,5,500)",
    );
    const { signToken } = require('../src/middleware/auth');
    const token = signToken(
      { id: 'admin', role: 'admin' },
      { id: 'org', slug: 'acme' },
    );
    server = require('../src/app').listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/v1`;
    async function call(method, path, body, expected = 200, authToken = token) {
      const { status, json } = await new Promise((resolve, reject) => {
        const request = http.request(
          url + path,
          {
            method,
            headers: {
              Host: 'acme.erp.test',
              Authorization: `Bearer ${authToken}`,
              'Content-Type': 'application/json',
            },
          },
          (response) => {
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (text += chunk));
            response.on('end', () => {
              try {
                resolve({
                  status: response.statusCode,
                  json: JSON.parse(text),
                });
              } catch (error) {
                reject(
                  new Error(
                    `${method} ${path}: HTTP ${response.statusCode}: ${text.slice(0, 500)}`,
                    { cause: error },
                  ),
                );
              }
            });
          },
        );
        request.on('error', reject);
        if (body !== undefined) request.write(JSON.stringify(body));
        request.end();
      });
      assert.equal(
        status,
        expected,
        `${method} ${path}: ${JSON.stringify(json)}`,
      );
      return json.data;
    }
    await t.test(
      'draft purchase CRUD includes child CRUD and rejects posted edits',
      async () => {
        await require('../src/middleware/rateLimiter').resetKey('127.0.0.1');
        const order = await call(
          'POST',
          '/purchase/orders',
          {
            vendor_id: 'vendor',
            warehouse_id: 'wh',
            items: [{ item_id: 'rm', quantity: 2, rate: 5 }],
          },
          201,
        );
        let detail = await call(
          'GET',
          `/operations/record?endpoint=%2Fpurchase%2Forders&id=${order.id}`,
        );
        const originalLine = detail.items[0].id;
        await call('PUT', `/purchase/orders/${order.id}`, {
          notes: 'updated',
          items: [{ id: originalLine, item_id: 'rm', quantity: 3, rate: 8 }],
        });
        await call(
          'PATCH',
          `/purchase/orders/${order.id}/items/${originalLine}`,
          { quantity: 4 },
        );
        await call(
          'POST',
          `/purchase/orders/${order.id}/items`,
          { item_id: 'fg', quantity: 1, rate: 2 },
          201,
        );
        detail = await call(
          'GET',
          `/operations/record?endpoint=%2Fpurchase%2Forders&id=${order.id}`,
        );
        assert.equal(detail.items.length, 2);
        assert.equal(Number(detail.total_amount), 34);
        const added = detail.items.find((line) => line.id !== originalLine);
        await call('DELETE', `/purchase/orders/${order.id}/items/${added.id}`);
        await call(
          'DELETE',
          `/purchase/orders/${order.id}/items/${originalLine}`,
          undefined,
          400,
        );
        await call('DELETE', `/purchase/orders/${order.id}`);
        await call('GET', `/purchase/orders/${order.id}`, undefined, 404);
        const setting = await call('POST', '/purchase/settings', {
          setting_key: 'approval_required',
          setting_value: 'true',
        });
        await call('PATCH', `/purchase/settings/${setting.setting_key}`, {
          setting_value: 'false',
        });
        await call('GET', `/purchase/settings/${setting.setting_key}`);
        await call('DELETE', `/purchase/settings/${setting.setting_key}`);
      },
    );
    await t.test(
      'all workspace list endpoints accept an empty tenant',
      async () => {
        await require('../src/middleware/rateLimiter').resetKey('127.0.0.1');
        const paths = [
          '/purchase/requisitions',
          '/purchase/rfqs',
          '/purchase/orders',
          '/purchase/grn',
          '/purchase/vendor-invoices',
          '/purchase/reports',
          '/purchase/settings',
          '/inventory/items',
          '/inventory/categories',
          '/inventory/uom',
          '/inventory/warehouses',
          '/inventory/stock',
          '/inventory/ledger',
          '/inventory/gate-pass',
          '/inventory/settings',
          '/production/orders',
          '/production/bom',
          '/production/work-orders',
          '/production/job-cards',
          '/production/reports',
          '/production/dashboard',
          '/production/settings',
          '/jobwork/orders',
          '/jobwork/challans',
          '/jobwork/receipts',
          '/jobwork/consumption',
          '/jobwork/finished-goods',
          '/jobwork/billing',
          '/jobwork/pending-material',
          '/jobwork/reports',
          '/jobwork/dashboard',
          '/jobwork/settings',
        ];
        for (const path of paths) await call('GET', path);
      },
    );
    await t.test(
      'disabled modules and restricted roles deny both list and workflow endpoints',
      async () => {
        await require('../src/middleware/rateLimiter').resetKey('127.0.0.1');
        await connection.query(`USE \`${masterName}\``);
        for (const [module, path] of [
          ['purchase', '/purchase/requisitions'],
          ['inventory', '/inventory/categories'],
          ['production', '/production/orders'],
          ['jobwork', '/jobwork/orders'],
        ]) {
          await connection.query(
            'INSERT INTO org_modules(org_id,module_key,is_active) VALUES(?,?,0)',
            ['org', module],
          );
          await call('GET', path, undefined, 403);
          await connection.query(
            'DELETE FROM org_modules WHERE org_id=? AND module_key=?',
            ['org', module],
          );
        }
        const viewer = signToken(
          { id: 'viewer', role: 'viewer' },
          { id: 'org', slug: 'acme' },
        );
        await call(
          'POST',
          '/purchase/requisitions/nope/submit',
          {},
          403,
          viewer,
        );
        await call('POST', '/inventory/stock/adjust', {}, 403, viewer);
        await call('POST', '/jobwork/orders', {}, 403, viewer);
      },
    );
    await t.test(
      'Purchase, Quality, Inventory and Production preserve stock and cost end-to-end',
      async () => {
        await require('../src/middleware/rateLimiter').resetKey('127.0.0.1');
        await db.query(
          "INSERT INTO warehouses(id,warehouse_code,warehouse_name) VALUES('flow-wh','FLOW-WH','Flow source'),('flow-wh2','FLOW-WH2','Flow destination')",
        );
        await db.query(
          "INSERT INTO item_master(id,item_code,item_name) VALUES('flow-rm','FLOW-RM','Flow raw'),('flow-fg','FLOW-FG','Flow finished')",
        );
        async function stock(item, warehouse, quantity, value) {
          const [[row]] = await db.query(
            'SELECT current_qty,total_value FROM stock_summary WHERE item_id=? AND warehouse_id=?',
            { replacements: [item, warehouse] },
          );
          assert.equal(Number(row?.current_qty || 0), quantity);
          assert.equal(Number(row?.total_value || 0), value);
        }
        const po = await call(
          'POST',
          '/purchase/orders',
          {
            vendor_id: 'vendor',
            warehouse_id: 'flow-wh',
            items: [{ item_id: 'flow-rm', quantity: 10, rate: 5 }],
          },
          201,
        );
        await call('PUT', `/purchase/orders/${po.id}/status`, {
          status: 'submitted',
        });
        await call('PUT', `/purchase/orders/${po.id}/status`, {
          status: 'approved',
        });
        await call(
          'PATCH',
          `/purchase/orders/${po.id}`,
          { notes: 'posted edit' },
          409,
        );
        const grn = await call(
          'POST',
          '/purchase/grn',
          {
            po_id: po.id,
            vendor_id: 'vendor',
            warehouse_id: 'flow-wh',
            items: [{ item_id: 'flow-rm', received_qty: 10, rate: 5 }],
          },
          201,
        );
        await call('POST', `/purchase/grn/${grn.id}/post`, {});
        await stock('flow-rm', 'flow-wh', 0, 0);
        const qc = await call(
          'POST',
          '/quality/inward',
          {
            reference_id: grn.id,
            item_id: 'flow-rm',
            inspected_qty: 10,
            accepted_qty: 10,
            rejected_qty: 0,
          },
          201,
        );
        await call('POST', `/quality/inspections/${qc.id}/process-result`, {
          accepted_qty: 10,
          rejected_qty: 0,
        });
        await call('POST', `/quality/inspections/${qc.id}/process-result`, {
          accepted_qty: 10,
          rejected_qty: 0,
        });
        await stock('flow-rm', 'flow-wh', 10, 50);
        const returned = await call(
          'POST',
          '/purchase/returns',
          {
            vendor_id: 'vendor',
            grn_id: grn.id,
            warehouse_id: 'flow-wh',
            reason: 'Draft return',
            items: [{ item_id: 'flow-rm', return_qty: 1, rate: 5 }],
          },
          201,
        );
        await call('GET', `/purchase/returns/${returned.id}`);
        await call('PUT', `/purchase/returns/${returned.id}`, {
          notes: 'Updated draft',
        });
        await call('PATCH', `/purchase/returns/${returned.id}`, {
          items: [{ item_id: 'flow-rm', quantity: 2, rate: 5 }],
        });
        await call('DELETE', `/purchase/returns/${returned.id}`);
        await stock('flow-rm', 'flow-wh', 10, 50);
        const transfer = await call(
          'POST',
          '/inventory/transfers',
          {
            from_warehouse_id: 'flow-wh',
            to_warehouse_id: 'flow-wh2',
            items: [{ item_id: 'flow-rm', quantity: 2, rate: 5 }],
          },
          201,
        );
        await call('POST', `/inventory/transfers/${transfer.id}/approve`, {});
        await call('POST', `/inventory/transfers/${transfer.id}/receive`, {});
        await call('POST', `/inventory/transfers/${transfer.id}/receive`, {});
        await stock('flow-rm', 'flow-wh', 8, 40);
        await stock('flow-rm', 'flow-wh2', 2, 10);
        const reservation = await call('POST', '/inventory/reservations', {
          item_id: 'flow-rm',
          warehouse_id: 'flow-wh',
          quantity: 1,
        });
        await call('PATCH', `/inventory/reservations/${reservation.id}`, {
          quantity: 2,
        });
        await call('DELETE', `/inventory/reservations/${reservation.id}`);
        const bom = await call(
          'POST',
          '/production/bom',
          { bom_code: 'FLOW-BOM', finished_item_id: 'flow-fg', output_qty: 1 },
          201,
        );
        await call('POST', `/production/bom/${bom.id}/components`, {
          components: [
            { item_id: 'flow-rm', quantity: 2, scrap_percent: 0, rate: 5 },
          ],
        });
        for (const [endpoint, body] of [
          [
            '/production/orders',
            { bom_id: bom.id, item_id: 'flow-fg', planned_qty: 1 },
          ],
          [
            '/production/work-orders',
            { bom_id: bom.id, finished_item_id: 'flow-fg', planned_qty: 1 },
          ],
        ]) {
          const draft = await call('POST', endpoint, body, 201);
          await call('GET', `${endpoint}/${draft.id}`);
          await call('PUT', `${endpoint}/${draft.id}`, { planned_qty: 2 });
          await call('PATCH', `${endpoint}/${draft.id}`, { planned_qty: 1 });
          await call('DELETE', `${endpoint}/${draft.id}`);
          await call('GET', `${endpoint}/${draft.id}`, undefined, 404);
        }
        const order = await call(
          'POST',
          '/production/orders',
          { bom_id: bom.id, item_id: 'flow-fg', planned_qty: 2 },
          201,
        );
        const released = await call(
          'POST',
          `/production/orders/${order.id}/release`,
          {},
        );
        const wo = released.work_order_id;
        const operation = await call(
          'POST',
          `/production/work-orders/${wo}/operations`,
          { stage_name: 'Cut', sequence_no: 1 },
          201,
        );
        await call(
          'PATCH',
          `/production/work-orders/${wo}/operations/${operation.id}`,
          { notes: 'plan revised' },
        );
        await call(
          'DELETE',
          `/production/work-orders/${wo}/operations/${operation.id}`,
        );
        for (const [endpoint, body, patch] of [
          [
            '/production/job-cards',
            { production_order_id: order.id, planned_qty: 1 },
            { planned_qty: 2 },
          ],
          [
            '/production/output',
            {
              production_order_id: order.id,
              item_id: 'flow-fg',
              warehouse_id: 'flow-wh',
              quantity: 1,
            },
            { quantity: 2 },
          ],
          [
            '/production/scrap',
            {
              production_order_id: order.id,
              item_id: 'flow-rm',
              warehouse_id: 'flow-wh',
              quantity: 1,
              reason: 'Draft test',
            },
            { quantity: 2 },
          ],
          [
            '/production/downtime',
            { production_order_id: order.id, minutes: 1, reason: 'Draft test' },
            { minutes: 2 },
          ],
        ]) {
          const draft = await call('POST', endpoint, body, 201);
          await call('GET', `${endpoint}/${draft.id}`);
          await call('PUT', `${endpoint}/${draft.id}`, patch);
          await call('PATCH', `${endpoint}/${draft.id}`, patch);
          await call('DELETE', `${endpoint}/${draft.id}`);
          await call('GET', `${endpoint}/${draft.id}`, undefined, 404);
        }
        await call('PUT', `/production/work-orders/${wo}/status`, {
          status: 'in_progress',
        });
        await call('POST', `/production/work-orders/${wo}/material-issue`, {
          warehouse_id: 'flow-wh',
        });
        await call('POST', `/production/work-orders/${wo}/complete`, {
          warehouse_id: 'flow-wh',
        });
        await call('POST', `/production/work-orders/${wo}/complete`, {
          warehouse_id: 'flow-wh',
        });
        await stock('flow-rm', 'flow-wh', 4, 20);
        await stock('flow-fg', 'flow-wh', 2, 20);
      },
    );
    await t.test(
      'Inventory master, tracking and draft-document CRUD run against migrated MySQL',
      async () => {
        await require('../src/middleware/rateLimiter').resetKey('127.0.0.1');
        for (const [endpoint, body, patch] of [
          [
            '/inventory/uom',
            { uom_code: 'CRUD', uom_name: 'CRUD unit' },
            { uom_name: 'Revised unit' },
          ],
          [
            '/inventory/warehouses',
            { warehouse_code: 'CRUD', warehouse_name: 'CRUD warehouse' },
            { warehouse_name: 'Revised warehouse' },
          ],
          [
            '/inventory/items',
            { item_code: 'CRUD', item_name: 'CRUD item' },
            { item_name: 'Revised item' },
          ],
          [
            '/inventory/locations',
            { warehouse_id: 'wh', code: 'CRUD', name: 'CRUD location' },
            { name: 'Revised location' },
          ],
        ]) {
          const record = await call('POST', endpoint, body, 201);
          await call('GET', `${endpoint}/${record.id}`);
          await call('PUT', `${endpoint}/${record.id}`, patch);
          await call('PATCH', `${endpoint}/${record.id}`, patch);
          await call('DELETE', `${endpoint}/${record.id}`);
          const inactive = await call('GET', `${endpoint}/${record.id}`);
          assert.equal(Number(inactive.is_active), 0);
        }
        for (const [endpoint, body, patch] of [
          [
            '/inventory/batches',
            { item_id: 'rm', warehouse_id: 'wh', batch_no: 'CRUD-B' },
            { batch_no: 'CRUD-B2' },
          ],
          [
            '/inventory/serials',
            { item_id: 'rm', warehouse_id: 'wh', serial_no: 'CRUD-S' },
            { serial_no: 'CRUD-S2' },
          ],
          [
            '/inventory/gate-pass',
            {
              pass_number: 'CRUD-G',
              pass_type: 'inward',
              item_id: 'rm',
              warehouse_id: 'wh',
              quantity: 1,
            },
            { quantity: 2 },
          ],
        ]) {
          const record = await call('POST', endpoint, body, 201);
          await call('GET', `${endpoint}/${record.id}`);
          await call('PUT', `${endpoint}/${record.id}`, patch);
          await call('PATCH', `${endpoint}/${record.id}`, patch);
          await call('DELETE', `${endpoint}/${record.id}`);
          await call('GET', `${endpoint}/${record.id}`, undefined, 404);
        }
        await call(
          'POST',
          '/inventory/gate-pass',
          {
            pass_number: 'INVALID',
            pass_type: 'bad',
            item_id: 'rm',
            warehouse_id: 'wh',
            quantity: 1,
          },
          400,
        );
        const count = await call(
          'POST',
          '/inventory/counts',
          { count_number: 'CRUD-C', warehouse_id: 'wh' },
          201,
        );
        await call(
          'POST',
          `/inventory/counts/${count.id}/items`,
          { item_id: 'rm', counted_qty: 100 },
          201,
        );
        const countDetail = await call('GET', `/inventory/counts/${count.id}`);
        const line = countDetail.items[0];
        await call('PATCH', `/inventory/counts/${count.id}/items/${line.id}`, {
          counted_qty: 99,
        });
        await call('DELETE', `/inventory/counts/${count.id}`);
        const pr = await call(
          'POST',
          '/purchase/requisitions',
          { warehouse_id: 'wh', items: [{ item_id: 'rm', quantity: 1 }] },
          201,
        );
        await call('POST', `/purchase/requisitions/${pr.id}/items`, {
          items: [{ item_id: 'rm', quantity: 2, rate: 5 }],
        });
        await call('PATCH', `/purchase/requisitions/${pr.id}`, {
          notes: 'Revised',
        });
        const detail = await call('GET', `/purchase/requisitions/${pr.id}`);
        assert.equal(Number(detail.items[0].quantity), 2);
        await call('DELETE', `/purchase/requisitions/${pr.id}`);
      },
    );
    await t.test(
      'Purchase sourcing and vendor invoice CRUD retain accounting integrity',
      async () => {
        await require('../src/middleware/rateLimiter').resetKey('127.0.0.1');
        const rfq = await call(
          'POST',
          '/purchase/rfqs',
          { rfq_number: 'CRUD-RFQ' },
          201,
        );
        await call('PUT', `/purchase/rfqs/${rfq.id}`, {
          items: [{ item_id: 'rm', quantity: 2 }],
        });
        await call('PATCH', `/purchase/rfqs/${rfq.id}`, {
          items: [{ item_id: 'rm', quantity: 3 }],
        });
        const quotation = await call(
          'POST',
          '/purchase/supplier-quotations',
          {
            quotation_number: 'CRUD-QUOTE',
            rfq_id: rfq.id,
            vendor_id: 'vendor',
          },
          201,
        );
        await call('PUT', `/purchase/supplier-quotations/${quotation.id}`, {
          items: [{ item_id: 'rm', quantity: 3, rate: 5 }],
        });
        await call('PATCH', `/purchase/supplier-quotations/${quotation.id}`, {
          items: [{ item_id: 'rm', quantity: 3, rate: 6 }],
        });
        const quoteDetail = await call(
          'GET',
          `/operations/record?endpoint=%2Fpurchase%2Fsupplier-quotations&id=${quotation.id}`,
        );
        assert.equal(Number(quoteDetail.total_amount), 18);
        await call('DELETE', `/purchase/supplier-quotations/${quotation.id}`);
        const supplier = await call(
          'POST',
          '/closure/rfq/suppliers',
          { rfq_id: rfq.id, supplier_id: 'vendor', status: 'invited' },
          201,
        );
        await call('PUT', `/closure/rfq/suppliers/${supplier.id}`, {
          supplier_id: 'vendor',
        });
        await call('PATCH', `/closure/rfq/suppliers/${supplier.id}`, {
          supplier_id: 'vendor',
        });
        await call('PUT', `/purchase/rfqs/${rfq.id}/status`, {
          status: 'requested',
        });
        const quoteLine = await call(
          'POST',
          '/closure/rfq/quotation-lines',
          {
            rfq_supplier_id: supplier.id,
            item_id: 'rm',
            quantity: 3,
            unit_price: 5,
          },
          201,
        );
        await call('PUT', `/closure/rfq/quotation-lines/${quoteLine.id}`, {
          unit_price: 6,
        });
        await call('PATCH', `/closure/rfq/quotation-lines/${quoteLine.id}`, {
          unit_price: 7,
        });
        await call('GET', `/closure/rfq/quotation-lines/${quoteLine.id}`);
        await call('DELETE', `/closure/rfq/quotation-lines/${quoteLine.id}`);
        await call('DELETE', `/closure/rfq/suppliers/${supplier.id}`);
        await call('DELETE', `/purchase/rfqs/${rfq.id}`, undefined, 409);
        const draft = await call(
          'POST',
          '/purchase/rfqs',
          { rfq_number: 'DELETE-RFQ' },
          201,
        );
        await call('DELETE', `/purchase/rfqs/${draft.id}`);
        const invoice = await call(
          'POST',
          '/purchase/vendor-invoices',
          {
            document_number: 'CRUD-INVOICE',
            document_date: '2026-10-08',
            party_id: 'vendor',
            amount: 118,
            taxable_amount: 100,
            cgst: 9,
            sgst: 9,
          },
          201,
        );
        await call('PUT', `/purchase/vendor-invoices/${invoice.id}`, {
          document_number: 'CRUD-INVOICE-REVISED',
        });
        await call('PATCH', `/purchase/vendor-invoices/${invoice.id}`, {
          due_date: '2026-12-01',
        });
        await call(
          'PATCH',
          `/purchase/vendor-invoices/${invoice.id}`,
          { amount: 200 },
          409,
        );
        await call('DELETE', `/purchase/vendor-invoices/${invoice.id}`);
        const cancelled = await call(
          'GET',
          `/purchase/vendor-invoices/${invoice.id}`,
        );
        assert.equal(cancelled.status, 'cancelled');
        const [[journal]] = await db.query(
          "SELECT status FROM finance_journals WHERE source_type='vendor_invoice' AND source_id=?",
          { replacements: [invoice.id] },
        );
        assert.equal(journal.status, 'reversed');
        const [[gst]] = await db.query(
          "SELECT SUM(CASE WHEN e.direction='debit' THEN e.amount ELSE -e.amount END) balance FROM gst_ledger_entries e JOIN gst_context_snapshots s ON s.id=e.snapshot_id WHERE s.source_id=?",
          { replacements: [invoice.id] },
        );
        assert.equal(Number(gst.balance), 0);
      },
    );
    await t.test(
      'Job Work concurrent retry posts one document and one stock effect',
      async () => {
        await require('../src/middleware/rateLimiter').resetKey('127.0.0.1');
        const body = {
          jw_number: 'JW-1',
          process_name: 'Process',
          item_id: 'rm',
          warehouse_id: 'wh',
          quantity: 10,
          vendor_id: 'vendor',
          idempotency_key: 'jw-order',
        };
        const [first, second] = await Promise.all([
          call('POST', '/jobwork/orders', body, 201),
          call('POST', '/jobwork/orders', body, 201),
        ]);
        assert.equal(first.id, second.id);
        await call('PUT', `/jobwork/orders/${first.id}`, {
          notes: 'Updated order',
        });
        await call('POST', `/jobwork/orders/${first.id}/submit`, {});
        const outward = {
          job_work_order_id: first.id,
          challan_number: 'JWC-1',
          warehouse_id: 'wh',
          items: [{ item_id: 'rm', quantity: 10 }],
          idempotency_key: 'jw-outward',
        };
        const [a, b] = await Promise.all([
          call('POST', '/jobwork/challans', outward, 201),
          call('POST', '/jobwork/challans', outward, 201),
        ]);
        assert.equal(a.id, b.id);
        const [[stock]] = await db.query(
          "SELECT current_qty,total_value FROM stock_summary WHERE item_id='rm' AND warehouse_id='wh'",
        );
        assert.equal(Number(stock.current_qty), 90);
        assert.equal(Number(stock.total_value), 450);
        const finished = await call(
          'POST',
          '/jobwork/finished-goods',
          {
            challan_id: a.id,
            receipt_number: 'JW-FG-1',
            item_id: 'fg',
            warehouse_id: 'wh',
            quantity: 2,
            rate: 5,
            requires_qc: false,
          },
          201,
        );
        await call('PUT', `/jobwork/finished-goods/${finished.id}`, {
          receipt_date: '2026-10-08',
        });
        await call('PATCH', `/jobwork/finished-goods/${finished.id}`, {
          receipt_date: '2026-10-09',
        });
        await call('GET', `/jobwork/finished-goods/${finished.id}`);
        await call('DELETE', `/jobwork/finished-goods/${finished.id}`);
        const bill = await call(
          'POST',
          '/jobwork/billing',
          {
            job_work_order_id: first.id,
            document_number: 'JW-BILL-1',
            document_date: '2026-10-08',
            amount: 50,
          },
          201,
        );
        const [[billRow]] = await db.query(
          'SELECT id FROM job_work_bills WHERE finance_document_id=?',
          { replacements: [bill.id] },
        );
        await call('GET', `/jobwork/billing/${billRow.id}`);
        await call('PUT', `/jobwork/billing/${billRow.id}`, {
          document_number: 'JW-BILL-REVISED',
        });
        await call('PATCH', `/jobwork/billing/${billRow.id}`, {
          due_date: '2026-12-01',
        });
        await call('DELETE', `/jobwork/billing/${billRow.id}`);
        const receipt = await call(
          'POST',
          '/jobwork/receipts',
          {
            challan_id: a.id,
            receipt_number: 'JWR-1',
            warehouse_id: 'wh',
            items: [{ item_id: 'rm', quantity: 4 }],
            rate: 5,
            idempotency_key: 'jw-receipt',
          },
          201,
        );
        await call(
          'POST',
          '/jobwork/consumption',
          { challan_id: a.id, item_id: 'rm', quantity: 7 },
          409,
        );
        const consumed = await call(
          'POST',
          '/jobwork/consumption',
          { challan_id: a.id, item_id: 'rm', quantity: 6 },
          201,
        );
        await call('PATCH', `/jobwork/challans/${a.id}`, {
          notes: 'Updated challan',
        });
        await call('GET', `/jobwork/receipts/${receipt.id}`);
        await call('PUT', `/jobwork/receipts/${receipt.id}`, {
          notes: 'Updated receipt',
        });
        await call('PATCH', `/jobwork/consumption/${consumed.id}`, {
          notes: 'Updated consumption',
        });
        await call('DELETE', `/jobwork/challans/${a.id}`, undefined, 409);
        await call('DELETE', `/jobwork/receipts/${receipt.id}`);
        await call('DELETE', `/jobwork/consumption/${consumed.id}`);
        await call('DELETE', `/jobwork/challans/${a.id}`);
        await call('DELETE', `/jobwork/orders/${first.id}`);
        const [[restored]] = await db.query(
          "SELECT current_qty,total_value FROM stock_summary WHERE item_id='rm' AND warehouse_id='wh'",
        );
        assert.equal(Number(restored.current_qty), 100);
        assert.equal(Number(restored.total_value), 500);
      },
    );
  },
);
