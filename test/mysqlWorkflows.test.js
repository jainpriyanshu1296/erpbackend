const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
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
      const res = await fetch(url + path, {
        method,
        headers: {
          Host: 'acme.erp.test',
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      assert.equal(
        res.status,
        expected,
        `${method} ${path}: ${JSON.stringify(json)}`,
      );
      return json.data;
    }
    await t.test(
      'draft purchase CRUD includes child CRUD and rejects posted edits',
      async () => {
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
      'Job Work concurrent retry posts one document and one stock effect',
      async () => {
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
        await call('POST', `/jobwork/challans/${a.id}/cancel`, {}, 409);
        await call('POST', `/jobwork/receipts/${receipt.id}/cancel`, {});
        await call('POST', `/jobwork/consumption/${consumed.id}/cancel`, {});
        await call('POST', `/jobwork/challans/${a.id}/cancel`, {});
        const [[restored]] = await db.query(
          "SELECT current_qty,total_value FROM stock_summary WHERE item_id='rm' AND warehouse_id='wh'",
        );
        assert.equal(Number(restored.current_qty), 100);
        assert.equal(Number(restored.total_value), 500);
      },
    );
  },
);
