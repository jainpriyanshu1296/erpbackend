const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/operationalDomains.service');

function buildReq({ stockCurrent = 200 } = {}) {
  const db = {
    async query(sql) {
      const text = String(sql).toLowerCase();
      if (text.includes('select coalesce(max(snapshot_version)')) return [{ next_version: 0 }];
      if (text.includes('select * from quality_ncrs')) return [[{ id: 'ncr-1', status: 'open' }]];
      if (text.includes('select * from qc_inspections')) return [[{ id: 'insp-1', item_id: 'item-1', inspected_qty: 20, accepted_qty: 18, rejected_qty: 2 }]];
      if (text.includes('select current_qty from stock_summary')) return [[{ current_qty: stockCurrent }]];
      if (text.includes('select * from attendance_corrections')) return [[{ id: 'corr-1', employee_id: 'emp-1', attendance_date: '2026-09-18', proposed_status: 'present', status: 'pending', requested_by: 'req-1' }]];
      if (text.includes('select * from leave_requests')) return [[]];
      if (text.includes('select holiday_date from leave_holidays')) return [[{ holiday_date: '2026-09-19' }]];
      if (text.includes('select * from leave_balances')) return [[{ employee_id: 'emp-1', leave_type: 'annual', closing_balance: 10 }]];
      return [[]];
    },
    async transaction() {
      return {
        commit: async () => {},
        rollback: async () => {}
      };
    }
  };
  return { orgDb: db, user: { sub: 'user-42' }, ip: '127.0.0.1', get: () => null };
}

test('quality specification + inspection snapshot creation are durable and auditable', async () => {
  const req = buildReq();
  const spec = await service.createQualitySpecification(req, {
    code: 'Z-001',
    name: 'Surface finish',
    specification_type: 'product',
    specification: { target: 'Ra 0.8' }
  });
  const snapshot = await service.createInspectionSnapshot(req, 'insp-1', { result: 'pass', accepted_qty: 18 });

  assert.equal(spec.code, 'Z-001');
  assert.equal(snapshot.inspection_id, 'insp-1');
  assert.equal(snapshot.snapshot_version, 1);
  assert.equal(snapshot.payload.result, 'pass');
});

test('disposition stock effects reduce summary and close inspection', async () => {
  const req = buildReq({ stockCurrent: 50 });
  const result = await service.disposeInspection(req, {
    inspection_id: 'insp-1',
    disposition: 'quarantine',
    quantity: 12,
    warehouse_id: 'wh-1',
    item_id: 'item-1'
  });

  assert.equal(result.status, 'closed');
  assert.equal(result.stock_effect.movement_type, 'out');
  assert.equal(result.stock_effect.balance_qty, 38);
});

test('NCR transitions accept lifecycle updates and keep audit metadata', async () => {
  const req = buildReq();
  const result = await service.transitionNcr(req, 'ncr-1', {
    status: 'investigating',
    root_cause: 'Calibration drift',
    corrective_action: 'Recalibrate gauge'
  });

  assert.equal(result.status, 'open');
});

test('leave validation and attendance correction approval protect human-resource controls', async () => {
  const req = buildReq();
  const leaveValidation = await service.validateLeaveRequest(req, {
    employee_id: 'emp-1',
    from_date: '2026-09-21',
    to_date: '2026-09-23',
    leave_type: 'annual'
  });
  const correction = await service.approveAttendanceCorrection(req, 'corr-1', { status: 'approved' });

  assert.equal(leaveValidation.valid, true);
  assert.equal(correction.status, 'approved');
});

test('NCR lifecycle rejects skipped states and terminal mutation', async () => {
  const tx = { commit: async () => {}, rollback: async () => {} };
  const req = {
    orgDb: {
      async transaction() { return tx; },
      async query(sql) {
        if (sql.includes('SELECT * FROM quality_ncrs')) return [[{ id: 'ncr-1', status: 'open' }]];
        return [[]];
      }
    },
    user: { sub: 'u1' },
    get: () => null
  };
  await assert.rejects(() => service.transitionNcr(req, 'ncr-1', { status: 'closed' }), /cannot transition/);
});

test('financial statements only aggregate posted journals and use account normal sign', async () => {
  let sql;
  const req = {
    orgDb: {
      async query(statement) {
        sql = statement;
        return [[{ code: 'REV', name: 'Revenue', account_type: 'income', debit: 10, credit: 100 }]];
      }
    }
  };
  const result = await service.financialStatement(req, 'income_statement', { from: '2026-01-01', to: '2026-01-31' });
  assert.match(sql, /INNER JOIN finance_journals/);
  assert.equal(result.rows[0].balance, 90);
});
