const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/operationalDomains.service');

test('payroll snapshot prorates payable days and preserves deduction totals', () => {
  const result = service.payrollSnapshot({ salary: 120000 }, { annual_ctc: 120000, components: { basic: 10000, allowances: 2000 } }, { working_days: 20, present_days: 10 }, { pf: 500, tax: 100 });
  assert.deepEqual(result, { gross: 6000, deductions: 600, net: 5400, components: { basic: 10000, allowances: 2000 }, attendance: { working_days: 20, present_days: 10 } });
});

test('GST calculation returns immutable authoritative totals', () => {
  const result = service.calculateGSTAuthoritative([{ quantity: 2, rate: 100, gst_rate: 18 }], 'KA', 'MH');
  assert.equal(result.totals.taxable, 200);
  assert.equal(result.totals.igst, 36);
  assert.equal(result.totals.total, 236);
  assert.equal(result.source, 'internal-gst-calculator-v1');
});

test('government documents are durable adapter boundaries, not unsupported claims', () => {
  assert.equal(service.integrationBoundary('einvoice', 'inv-1', {}).status, 'pending');
  assert.throws(() => service.integrationBoundary('gstn', 'x', {}), /Unsupported/);
});

test('reports reject arbitrary SQL and validate pagination ranges', () => {
  assert.equal(service.reportDefinition('receivables').module, 'finance');
  assert.throws(() => service.reportDefinition('DROP TABLE invoices'), /not available/);
  assert.deepEqual(service.range({ from: '2026-01-01', to: '2026-01-31' }), ['2026-01-01', '2026-01-31']);
  assert.throws(() => service.range({ from: '2026-02-01', to: '2026-01-01' }), /Invalid date range/);
});

test('finance account creation rejects indirect hierarchy cycles', async () => {
  const db = {
    async query(sql) {
      if (String(sql).includes('WHERE id=? AND is_active=1')) return [[{ id: 'parent', parent_id: 'ancestor' }]];
      return [[{ parent_id: 'parent' }]];
    }
  };
  await assert.rejects(
    service.createAccount({ orgDb: db }, { code: 'CYCLE', name: 'Cycle', account_type: 'asset', parent_id: 'parent', id: 'ancestor' }),
    /cycle/
  );
});

test('journal posting fails when no accounting period covers the journal date', async () => {
  const db = {
    async transaction() { return { commit: async () => {}, rollback: async () => {} }; },
    async query(sql) {
      const text = String(sql);
      if (text.includes('SELECT * FROM finance_journals')) return [[{ id: 'j-1', status: 'approved', journal_date: '2026-09-19' }]];
      if (text.includes('FROM finance_periods')) return [[]];
      return [[]];
    }
  };
  await assert.rejects(
    service.submitJournal({ orgDb: db, user: { sub: 'u-1' } }, 'j-1', 'post'),
    /No accounting period/
  );
});
