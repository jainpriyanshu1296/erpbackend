const { v4: uuid } = require('uuid');
const { calculateGST } = require('../utils/gst-calculator');
const { postVendorInvoiceEffect, postVendorPaymentEffect, postBankEffect } = require('./accounting.service');

const REPORTS = {
  receivables: { sql: 'SELECT i.id,i.invoice_number,i.invoice_date,i.total_amount,i.balance_amount,i.status FROM invoices i WHERE i.balance_amount > 0 AND i.invoice_date BETWEEN ? AND ? ORDER BY i.invoice_date DESC', module: 'finance' },
  payables: { sql: 'SELECT id,document_number,document_date,amount,status,due_date FROM finance_documents WHERE document_type="payable" AND document_date BETWEEN ? AND ? ORDER BY document_date DESC', module: 'finance' },
  ar_ageing: { sql: 'SELECT i.id,i.invoice_number,i.invoice_date,i.due_date,i.balance_amount,CASE WHEN DATEDIFF(CURDATE(),COALESCE(i.due_date,i.invoice_date))<=0 THEN "current" WHEN DATEDIFF(CURDATE(),COALESCE(i.due_date,i.invoice_date))<=30 THEN "1-30" WHEN DATEDIFF(CURDATE(),COALESCE(i.due_date,i.invoice_date))<=60 THEN "31-60" WHEN DATEDIFF(CURDATE(),COALESCE(i.due_date,i.invoice_date))<=90 THEN "61-90" ELSE "90+" END ageing_bucket FROM invoices i WHERE i.balance_amount>0 AND i.invoice_date BETWEEN ? AND ? ORDER BY i.due_date', module: 'finance' },
  ap_ageing: { sql: 'SELECT f.id,f.document_number,f.document_date,f.due_date,f.amount,CASE WHEN DATEDIFF(CURDATE(),COALESCE(f.due_date,f.document_date))<=0 THEN "current" WHEN DATEDIFF(CURDATE(),COALESCE(f.due_date,f.document_date))<=30 THEN "1-30" WHEN DATEDIFF(CURDATE(),COALESCE(f.due_date,f.document_date))<=60 THEN "31-60" WHEN DATEDIFF(CURDATE(),COALESCE(f.due_date,f.document_date))<=90 THEN "61-90" ELSE "90+" END ageing_bucket FROM finance_documents f WHERE f.document_type="payable" AND f.status NOT IN ("paid","cancelled") AND f.document_date BETWEEN ? AND ? ORDER BY f.due_date', module: 'finance' },
  attendance: { sql: 'SELECT employee_id,COUNT(*) total_days,SUM(status="absent") absent_days FROM attendance WHERE attendance_date BETWEEN ? AND ? GROUP BY employee_id ORDER BY absent_days DESC', module: 'hr' },
  quality: { sql: 'SELECT status,COUNT(*) inspections FROM qc_inspections WHERE created_at BETWEEN ? AND ? GROUP BY status', module: 'quality' },
  gst: { sql: 'SELECT filing_period,SUM(taxable_amount) taxable_amount,SUM(cgst) cgst,SUM(sgst) sgst,SUM(igst) igst FROM tax_transactions WHERE transaction_date BETWEEN ? AND ? GROUP BY filing_period ORDER BY filing_period', module: 'gst' },
  payroll: { sql: 'SELECT pr.run_number,pr.period_start,pr.period_end,pr.status,COUNT(pp.id) payslips,COALESCE(SUM(pp.gross_amount),0) gross_amount,COALESCE(SUM(pp.net_amount),0) net_amount FROM payroll_runs pr LEFT JOIN payroll_payslips pp ON pp.payroll_run_id=pr.id WHERE pr.period_start >= ? AND pr.period_end <= ? GROUP BY pr.id ORDER BY pr.period_end DESC', module: 'payroll' },
  leave: { sql: 'SELECT status,COUNT(*) requests,COALESCE(SUM(days),0) days FROM leave_requests WHERE from_date >= ? AND to_date <= ? GROUP BY status ORDER BY status', module: 'hr' },
  ncr: { sql: 'SELECT status,severity,COUNT(*) count FROM quality_ncrs WHERE created_at BETWEEN ? AND ? GROUP BY status,severity ORDER BY status,severity', module: 'quality' }
};
function error(message, status = 400) { return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR' }); }
function payrollSnapshot(employee, assignment, attendance = {}, deductions = {}) {
  const components = assignment?.components || {};
  const annual = Number(assignment?.annual_ctc || employee.salary || 0);
  const monthly = Number(components.basic ?? annual / 12) + Number(components.allowances || 0);
  const days = Math.max(1, Number(attendance.working_days || 26));
  const payable = Math.min(days, Math.max(0, Number(attendance.present_days ?? days) + Number(attendance.paid_leave || 0)));
  const gross = monthly * payable / days;
  const total = Object.values(deductions).reduce((sum, value) => sum + Math.max(0, Number(value || 0)), 0);
  return { gross: Math.round(gross * 100) / 100, deductions: Math.round(total * 100) / 100, net: Math.round((gross - total) * 100) / 100, components, attendance };
}
function calculateGSTAuthoritative(items, orgState, customerState) {
  if (!Array.isArray(items) || !items.length) throw error('At least one tax item is required');
  const lines = calculateGST(items, orgState, customerState);
  const totals = lines.reduce((a, line) => { for (const k of ['taxable','cgst','sgst','igst','total']) a[k] += Number(line[k] || 0); return a; }, { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });
  for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k] * 100) / 100;
  return { lines, totals, interstate: Boolean(orgState && customerState && orgState !== customerState), source: 'internal-gst-calculator-v1' };
}
function integrationBoundary(type, sourceId, payload) {
  if (!['einvoice', 'ewaybill'].includes(type)) throw error('Unsupported government document type');
  return { document_type: type, source_id: sourceId, status: 'pending', request_payload: payload, integration: 'provider-adapter-required' };
}
function reportDefinition(key) { if (!REPORTS[key]) throw error('Report is not available', 404); return REPORTS[key]; }
function range(params = {}) {
  const end = params.to || new Date().toISOString().slice(0, 10);
  const start = params.from || `${new Date(`${end}T00:00:00Z`).getUTCFullYear()}-01-01`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw error('Invalid date range');
  return [start, end];
}
async function createNcr(req, body) {
  if (!body.ncr_number || !body.description) throw error('ncr_number and description are required');
  const id = uuid();
  await req.orgDb.query('INSERT INTO quality_ncrs(id,ncr_number,inspection_id,severity,description,status,owner_id) VALUES(?,?,?,?,?,?,?)', { replacements: [id, body.ncr_number, body.inspection_id || null, body.severity || 'major', body.description, 'open', req.user?.sub || null] });
  return { id, status: 'open' };
}
async function disposeInspection(req, body) {
  if (!body.inspection_id || !body.disposition || Number(body.quantity) <= 0) throw error('inspection_id, disposition and positive quantity are required');
  if (body.batch_id && body.serial_id) throw error('Disposition must target a batch or serial, not both');
  if (body.serial_id && Number(body.quantity) !== 1) throw error('Serial disposition quantity must be exactly one');
  const tx = await req.orgDb.transaction(); const id = uuid(); const effect = `${body.inspection_id}:${body.disposition}:${body.quantity}`;
  try {
    const [existing] = await req.orgDb.query('SELECT id,effect_key FROM quality_dispositions WHERE effect_key=?', { replacements: [effect], transaction: tx });
    if (existing[0]) { await tx.commit(); return { ...existing[0], already_applied: true, status: 'closed' }; }
    await req.orgDb.query('INSERT INTO quality_dispositions(id,inspection_id,disposition,quantity,warehouse_id,effect_key,created_by) VALUES(?,?,?,?,?,?,?)', { replacements: [id, body.inspection_id, body.disposition, body.quantity, body.warehouse_id || null, effect, req.user?.sub || null], transaction: tx });
    await req.orgDb.query('UPDATE qc_inspections SET status=?,result=? WHERE id=?', { replacements: ['closed', body.disposition, body.inspection_id], transaction: tx });
    await tx.commit(); return { id, effect_key: effect, status: 'closed' };
  } catch (e) { await tx.rollback(); throw e; }
}
async function finalizePayroll(req, runId) {
  const tx = await req.orgDb.transaction();
  try {
    const [run] = await req.orgDb.query('SELECT * FROM payroll_runs WHERE id=? FOR UPDATE', { replacements: [runId], transaction: tx });
    if (!run[0]) throw error('Payroll run not found', 404);
    if (run[0].status === 'processed' || run[0].status === 'approved' || run[0].status === 'paid') {
      const [snapshots] = await req.orgDb.query('SELECT COUNT(*) AS count FROM payroll_snapshots WHERE payroll_run_id=?', { replacements: [runId], transaction: tx });
      await tx.commit();
      return { id: runId, status: run[0].status, snapshot_count: Number(snapshots[0].count), already_finalized: true };
    }
    if (run[0].status !== 'draft') throw error('Only draft payroll runs can be finalized', 409);
    const [items] = await req.orgDb.query('SELECT * FROM payroll_items WHERE payroll_run_id=?', { replacements: [runId], transaction: tx });
    for (const item of items) {
      const payload = typeof item.payload === 'string' ? JSON.parse(item.payload || '{}') : (item.payload || item);
      await req.orgDb.query('INSERT INTO payroll_snapshots(id,payroll_run_id,employee_id,payload,gross_amount,deductions,net_amount) VALUES(?,?,?,?,?,?,?)', { replacements: [uuid(), runId, item.employee_id, JSON.stringify(payload), item.gross_amount, item.deductions, item.net_amount], transaction: tx });
      const statutory = payload.statutory_deductions || {};
      for (const [deductionType, amount] of Object.entries(statutory)) {
        if (Number(amount) > 0) await req.orgDb.query('INSERT INTO payroll_statutory_deductions(id,payroll_run_id,employee_id,deduction_type,amount,payload) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE amount=VALUES(amount),payload=VALUES(payload)',
          { replacements: [uuid(), runId, item.employee_id, deductionType, Number(amount), JSON.stringify(payload)], transaction: tx });
      }
      await req.orgDb.query('INSERT INTO payroll_payslips(id,payroll_run_id,employee_id,payslip_number,payload,gross_amount,deductions,net_amount) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload),gross_amount=VALUES(gross_amount),deductions=VALUES(deductions),net_amount=VALUES(net_amount)',
        { replacements: [uuid(), runId, item.employee_id, `PAYSLIP-${runId}-${item.employee_id}`, JSON.stringify(payload), item.gross_amount, item.deductions, item.net_amount], transaction: tx });
    }
    await req.orgDb.query('UPDATE payroll_runs SET status="processed",processed_by=? WHERE id=?', { replacements: [req.user?.sub || null, runId], transaction: tx });
    await tx.commit(); return { id: runId, status: 'processed', snapshot_count: items.length };
  } catch (e) { await tx.rollback(); throw e; }
}
async function report(req, key, params) {
  const def = reportDefinition(key); const [from, to] = range(params);
  const limit = Math.min(500, Math.max(1, Number(params.limit || 50))); const offset = Math.max(0, Number(params.offset || 0));
  let sql = `${def.sql} LIMIT ${limit} OFFSET ${offset}`; const replacements = def.sql.includes('?') ? [from, to] : [];
  if (params.employee_id && ['attendance', 'leave', 'payroll'].includes(key)) {
    const column = key === 'payroll' ? 'pp.employee_id' : 'employee_id';
    sql = sql.replace(/ LIMIT \d+ OFFSET \d+$/, ` AND ${column}=? LIMIT ${limit} OFFSET ${offset}`);
    replacements.push(String(params.employee_id));
  }
  const [rows] = await req.orgDb.query(sql, { replacements }); return { report: key, from, to, limit, offset, rows };
}
async function getPayslip(req, runId, employeeId) {
  const [rows] = await req.orgDb.query(
    'SELECT p.*,r.status run_status FROM payroll_payslips p JOIN payroll_runs r ON r.id=p.payroll_run_id WHERE p.payroll_run_id=? AND p.employee_id=?',
    { replacements: [runId, employeeId] }
  );
  if (!rows[0]) throw error('Payslip not found', 404);
  return rows[0];
}
async function closePeriod(req, periodKey) {
  const tx = await req.orgDb.transaction();
  try {
    const [rows] = await req.orgDb.query('SELECT * FROM finance_periods WHERE period_key=? FOR UPDATE', { replacements: [periodKey], transaction: tx });
    if (!rows[0]) throw error('Finance period not found', 404);
    if (rows[0].status === 'closed') { await tx.commit(); return rows[0]; }
    await req.orgDb.query('UPDATE finance_periods SET status="closed",closed_by=?,closed_at=NOW() WHERE period_key=?', { replacements: [req.user?.sub || null, periodKey], transaction: tx });
    await tx.commit(); return { ...rows[0], status: 'closed' };
  } catch (e) { await tx.rollback(); throw e; }
}
async function reverseJournal(req, id) {
  const tx = await req.orgDb.transaction();
  try {
    const [rows] = await req.orgDb.query('SELECT * FROM finance_journals WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    if (!rows[0]) throw error('Journal not found', 404);
    if (rows[0].status !== 'posted') throw error('Only posted journals can be reversed', 409);
    const [existing] = await req.orgDb.query('SELECT id FROM finance_journals WHERE journal_number=?', { replacements: [`REV-${rows[0].journal_number}`], transaction: tx });
    if (existing[0]) { await tx.commit(); return { id, reversal_id: existing[0].id, status: 'reversed', already_reversed: true }; }
    const reversalId = uuid();
    await req.orgDb.query('INSERT INTO finance_journals(id,journal_number,journal_date,narration,status,total_debit,created_by) VALUES(?,?,?,?,?,?,?)',
      { replacements: [reversalId, `REV-${rows[0].journal_number}`, new Date().toISOString().slice(0, 10), `Reversal of ${rows[0].journal_number}`, 'posted', rows[0].total_debit, req.user?.sub || null], transaction: tx });
    const [lines] = await req.orgDb.query('SELECT account_id,debit,credit FROM finance_journal_lines WHERE journal_id=?', { replacements: [id], transaction: tx });
    for (const line of lines) await req.orgDb.query('INSERT INTO finance_journal_lines(id,journal_id,account_id,debit,credit) VALUES(?,?,?,?,?)',
      { replacements: [uuid(), reversalId, line.account_id, line.credit, line.debit], transaction: tx });
    await req.orgDb.query('UPDATE finance_journals SET status="reversed" WHERE id=?', { replacements: [id], transaction: tx });
    await tx.commit();
    return { id, reversal_id: reversalId, status: 'reversed' };
  } catch (e) { await tx.rollback(); throw e; }
}
async function createFinanceDocument(req, body) {
  if (!body.document_type || !body.document_number || !body.document_date || !Number.isFinite(Number(body.amount)) || Number(body.amount) < 0) throw error('document_type, number, date and non-negative amount are required');
  const tx = await req.orgDb.transaction();
  try {
    const id = uuid();
    await req.orgDb.query('INSERT INTO finance_documents(id,document_type,document_number,party_id,document_date,amount,status,due_date,taxable_amount,cgst,sgst,igst) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      { replacements: [id, body.document_type, body.document_number, body.party_id || null, body.document_date, body.amount, 'open', body.due_date || null, body.taxable_amount ?? body.amount, body.cgst || 0, body.sgst || 0, body.igst || 0], transaction: tx });
    if (body.document_type === 'payable') await postVendorInvoiceEffect(req.orgDb, id, req.user?.sub, tx);
    await tx.commit();
    return { id, status: 'open', journal_posted: body.document_type === 'payable' };
  } catch (e) { await tx.rollback(); throw e; }
}
async function reconcileBank(req, id) {
  const tx = await req.orgDb.transaction();
  try {
    const [rows] = await req.orgDb.query('SELECT * FROM bank_transactions WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
  if (!rows[0]) throw error('Bank transaction not found', 404);
    if (rows[0].status === 'reconciled' && rows[0].journal_id) { await tx.commit(); return { id, status: 'reconciled', already_reconciled: true }; }
    const result = await postBankEffect(req.orgDb, id, { amount: rows[0].amount, direction: rows[0].direction, accountCode: rows[0].account_code || '1110', userId: req.user?.sub, date: rows[0].transaction_date, narration: rows[0].reference }, tx);
    await req.orgDb.query('UPDATE bank_transactions SET status="reconciled",journal_id=?,reconciled_at=NOW() WHERE id=?', { replacements: [result.journal_id, id], transaction: tx });
    await tx.commit(); return { id, status: 'reconciled', journal_id: result.journal_id };
  } catch (e) { await tx.rollback(); throw e; }
}

async function createBankTransaction(req, body = {}) {
  const amount = Number(body.amount);
  if (!body.transaction_date || !Number.isFinite(amount) || amount <= 0 || !['receipt', 'payment', 'transfer_in', 'transfer_out'].includes(body.direction)) throw error('transaction_date, positive amount and valid direction are required');
  const tx = await req.orgDb.transaction();
  try {
    const id = uuid();
    await req.orgDb.query('INSERT INTO bank_transactions(id,account_id,transaction_date,reference,amount,direction,status,contra_account_id) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [id, body.account_id || '1110', body.transaction_date, body.reference || null, amount, body.direction, 'unreconciled', body.contra_account_id || null], transaction: tx });
    const result = await postBankEffect(req.orgDb, id, { amount, direction: body.direction, accountCode: body.account_code || '1110', contraAccountCode: body.contra_account_code || '1100', userId: req.user?.sub, date: body.transaction_date, narration: body.narration || body.reference }, tx);
    await req.orgDb.query('UPDATE bank_transactions SET status="reconciled",journal_id=?,reconciled_at=NOW() WHERE id=?', { replacements: [result.journal_id, id], transaction: tx });
    await tx.commit(); return { id, status: 'reconciled', journal_id: result.journal_id };
  } catch (e) { await tx.rollback(); throw e; }
}

async function transitionExpense(req, id, action) {
  if (!['approve', 'reject', 'post'].includes(action)) throw error('Invalid expense action');
  const tx = await req.orgDb.transaction();
  try {
    const [docs] = await req.orgDb.query('SELECT * FROM finance_documents WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    if (!docs[0] || docs[0].document_type !== 'expense') throw error('Expense not found', 404);
    const [states] = await req.orgDb.query('SELECT * FROM expense_approvals WHERE document_id=? FOR UPDATE', { replacements: [id], transaction: tx });
    const current = states[0];
    if (action === 'approve') {
      await req.orgDb.query('INSERT INTO expense_approvals(id,document_id,status,requested_by,decided_by,decided_at) VALUES(?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE status="approved",decided_by=VALUES(decided_by),decided_at=NOW()',
        { replacements: [uuid(), id, 'approved', req.user?.sub || null, req.user?.sub || null], transaction: tx });
      await req.orgDb.query('UPDATE finance_documents SET status="approved",approved_by=?,approved_at=NOW() WHERE id=?', { replacements: [req.user?.sub || null, id], transaction: tx });
    } else if (action === 'reject') {
      await req.orgDb.query('UPDATE expense_approvals SET status="rejected",decided_by=?,decided_at=NOW() WHERE document_id=?', { replacements: [req.user?.sub || null, id], transaction: tx });
      await req.orgDb.query('UPDATE finance_documents SET status="rejected" WHERE id=?', { replacements: [id], transaction: tx });
    } else {
      if (!current || current.status !== 'approved') throw error('Expense must be approved before posting', 409);
      const result = await postVendorPaymentEffect(req.orgDb, id, id, Number(docs[0].amount), 'bank', req.user?.sub, tx);
      await req.orgDb.query('UPDATE expense_approvals SET status="posted" WHERE document_id=?', { replacements: [id], transaction: tx });
      await req.orgDb.query('UPDATE finance_documents SET status="posted",posted_at=NOW() WHERE id=?', { replacements: [id], transaction: tx });
      await tx.commit(); return { id, status: 'posted', journal_id: result.journal_id };
    }
    await tx.commit(); return { id, status: action === 'approve' ? 'approved' : 'rejected' };
  } catch (e) { await tx.rollback(); throw e; }
}

async function recordVendorPayment(req, documentId, body = {}) {
  const tx = await req.orgDb.transaction();
  try {
    const [docs] = await req.orgDb.query('SELECT * FROM finance_documents WHERE id=? FOR UPDATE', { replacements: [documentId], transaction: tx });
    if (!docs[0] || docs[0].document_type !== 'payable') throw error('Payable document not found', 404);
    const amount = Number(body.amount || docs[0].amount);
    const paidAmount = Number(docs[0].paid_amount || 0);
    const outstanding = Number(docs[0].amount) - paidAmount;
    if (!Number.isFinite(amount) || amount <= 0 || amount > outstanding) throw error('Invalid payment amount');
    const paymentId = body.payment_id || uuid();
    const result = await postVendorPaymentEffect(req.orgDb, paymentId, documentId, amount, body.method || 'bank', req.user?.sub, tx);
    const newPaidAmount = paidAmount + amount;
    await req.orgDb.query('UPDATE finance_documents SET paid_amount=?, status=CASE WHEN ?>=amount THEN "paid" ELSE "part_paid" END WHERE id=?', { replacements: [newPaidAmount, newPaidAmount, documentId], transaction: tx });
    await tx.commit(); return { payment_id: paymentId, document_id: documentId, amount, journal_id: result.journal_id };
  } catch (e) { await tx.rollback(); throw e; }
}

function evaluateFormula(formula, values = {}) {
  if (!formula) return 0;
  const expression = String(formula).replace(/[A-Za-z_][A-Za-z0-9_]*/g, name => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw error(`Unknown payroll formula variable: ${name}`);
    return Number(values[name]) || 0;
  });
  if (!/^[0-9+\-*/().\s]+$/.test(expression)) throw error('Invalid payroll formula');
  // Formula input is restricted to numbers and arithmetic operators above.
  return Math.round(Function(`"use strict"; return (${expression})`)() * 100) / 100;
}

async function savePayrollComponent(req, body) {
  if (!body.code || !body.name) throw error('code and name are required');
  const id = uuid();
  await req.orgDb.query(
    'INSERT INTO payroll_components(id,code,name,component_type,formula,taxable,statutory) VALUES(?,?,?,?,?,?,?)',
    { replacements: [id, body.code, body.name, body.component_type || 'earning', body.formula || null, body.taxable === false ? 0 : 1, body.statutory ? 1 : 0] }
  );
  return { id, code: body.code };
}

async function recordPayrollOvertime(req, body = {}) {
  if (!body.payroll_run_id || !body.employee_id || !body.overtime_date || Number(body.hours) <= 0 || Number(body.hourly_rate) < 0) {
    throw error('payroll_run_id, employee_id, overtime_date, positive hours and hourly_rate are required');
  }
  const id = uuid();
  const amount = Math.round(Number(body.hours) * Number(body.hourly_rate) * 100) / 100;
  await req.orgDb.query(
    'INSERT INTO payroll_overtime(id,payroll_run_id,employee_id,overtime_date,hours,hourly_rate,amount,status,approved_by) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE hours=VALUES(hours),hourly_rate=VALUES(hourly_rate),amount=VALUES(amount),status=VALUES(status),approved_by=VALUES(approved_by)',
    { replacements: [id, body.payroll_run_id, body.employee_id, body.overtime_date, Number(body.hours), Number(body.hourly_rate), amount, body.status || 'approved', req.user?.sub || null] }
  );
  return { id, payroll_run_id: body.payroll_run_id, employee_id: body.employee_id, hours: Number(body.hours), hourly_rate: Number(body.hourly_rate), amount };
}

async function calculatePayroll(req, runId) {
  const tx = await req.orgDb.transaction();
  try {
    const [runs] = await req.orgDb.query('SELECT * FROM payroll_runs WHERE id=? FOR UPDATE', { replacements: [runId], transaction: tx });
    if (!runs[0]) throw error('Payroll run not found', 404);
    if (['approved', 'processed', 'paid', 'locked'].includes(runs[0].status)) throw error('Payroll run is immutable', 409);
    const [employees] = await req.orgDb.query(
      'SELECT e.*,pa.id assignment_id,pa.annual_ctc,pa.components FROM employees e JOIN payroll_assignments pa ON pa.employee_id=e.id AND pa.effective_from=(SELECT MAX(p2.effective_from) FROM payroll_assignments p2 WHERE p2.employee_id=e.id AND p2.effective_from<=COALESCE(?,CURDATE())) WHERE e.status="active"',
      { replacements: [runs[0].period_end || null], transaction: tx }
    );
    let total = 0;
    for (const employee of employees) {
      const [attendance] = await req.orgDb.query(
        'SELECT COUNT(*) working_days,SUM(status="present") present_days,SUM(status="half_day") half_days,SUM(status="paid_leave") paid_leave FROM attendance WHERE employee_id=? AND attendance_date BETWEEN COALESCE(?,DATE_FORMAT(CURDATE(),"%Y-%m-01")) AND COALESCE(?,LAST_DAY(CURDATE()))',
        { replacements: [employee.id, runs[0].period_start, runs[0].period_end], transaction: tx }
      );
      const payload = payrollSnapshot(employee, { annual_ctc: employee.annual_ctc, components: typeof employee.components === 'string' ? JSON.parse(employee.components || '{}') : (employee.components || {}) }, attendance[0] || {});
      const [componentRows] = await req.orgDb.query(
        'SELECT pc.code,pc.component_type,pc.formula,pac.amount,pac.formula assignment_formula FROM payroll_assignment_components pac JOIN payroll_components pc ON pc.id=pac.component_id WHERE pac.assignment_id=? AND pac.effective_from=(SELECT MAX(p2.effective_from) FROM payroll_assignment_components p2 WHERE p2.assignment_id=pac.assignment_id AND p2.component_id=pac.component_id AND p2.effective_from<=?) AND pc.is_active=1',
        { replacements: [employee.assignment_id, runs[0].period_end], transaction: tx }
      );
      const formulaValues = { basic: Number(payload.components.basic || payload.gross || 0), gross: Number(payload.gross || 0), annual_ctc: Number(employee.annual_ctc || 0), working_days: Number(attendance[0]?.working_days || 26) };
      payload.components = { ...payload.components };
      for (const component of componentRows) {
        const formula = component.assignment_formula || component.formula;
        const amount = formula ? evaluateFormula(formula, formulaValues) : Number(component.amount || 0);
        if (amount < 0) throw error('Payroll component amount cannot be negative');
        payload.components[component.code] = amount;
        formulaValues[component.code] = amount;
        if (component.component_type === 'earning') payload.gross = Math.round((Number(payload.gross) + amount) * 100) / 100;
        else payload.deductions = Math.round((Number(payload.deductions) + amount) * 100) / 100;
      }
      payload.net = Math.round((Number(payload.gross) - Number(payload.deductions)) * 100) / 100;
      const [overtimeRows] = await req.orgDb.query(
        'SELECT COALESCE(SUM(amount),0) overtime_amount,COALESCE(SUM(hours),0) overtime_hours FROM payroll_overtime WHERE payroll_run_id=? AND employee_id=? AND status="approved"',
        { replacements: [runId, employee.id], transaction: tx }
      );
      const overtime = Number(overtimeRows[0]?.overtime_amount || 0);
      payload.overtime = { hours: Number(overtimeRows[0]?.overtime_hours || 0), amount: overtime };
      payload.gross = Math.round((payload.gross + overtime) * 100) / 100;
      payload.net = Math.round((payload.net + overtime) * 100) / 100;
      if (payload.deductions > payload.gross) throw Object.assign(new Error('Payroll deductions cannot exceed gross'), { status: 422, code: 'PAYROLL_BOUNDARY' });
      total += payload.net;
      await req.orgDb.query(
        'INSERT INTO payroll_items(id,payroll_run_id,employee_id,gross_amount,deductions,net_amount) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE gross_amount=VALUES(gross_amount),deductions=VALUES(deductions),net_amount=VALUES(net_amount)',
        { replacements: [uuid(), runId, employee.id, payload.gross, payload.deductions, payload.net], transaction: tx }
      );
    }
    await req.orgDb.query('UPDATE payroll_runs SET total_amount=?,status="calculated" WHERE id=?', { replacements: [total, runId], transaction: tx });
    await tx.commit();
    return { id: runId, status: 'calculated', total_amount: Math.round(total * 100) / 100, employee_count: employees.length };
  } catch (e) { await tx.rollback(); throw e; }
}

async function transitionPayroll(req, runId, transition) {
  const allowed = { review: ['calculated'], approve: ['reviewed'], lock: ['approved'] };
  if (!allowed[transition]) throw error('Invalid payroll transition');
  const tx = await req.orgDb.transaction();
  try {
    const [rows] = await req.orgDb.query('SELECT * FROM payroll_runs WHERE id=? FOR UPDATE', { replacements: [runId], transaction: tx });
    if (!rows[0]) throw error('Payroll run not found', 404);
    if (!allowed[transition].includes(rows[0].status)) throw error(`Payroll run cannot be ${transition}d`, 409);
    const status = { review: 'reviewed', approve: 'approved', lock: 'locked' }[transition];
    const actor = req.user?.sub || null;
    const fields = transition === 'review' ? 'reviewed_by=?,reviewed_at=NOW()' : transition === 'approve' ? 'approved_by=?,approved_at=NOW()' : 'locked_by=?,locked_at=NOW()';
    await req.orgDb.query(`UPDATE payroll_runs SET status=?,${fields} WHERE id=?`, { replacements: [status, actor, runId], transaction: tx });
    await req.orgDb.query(
      'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [uuid(), actor, 'payroll', `payroll.${transition}`, 'payroll_run', runId, JSON.stringify({ from: rows[0].status, to: status }), req.ip || null], transaction: tx }
    );
    await tx.commit(); return { id: runId, status };
  } catch (e) { await tx.rollback(); throw e; }
}

async function createAccount(req, body) {
  if (!body.code || !body.name || !body.account_type) throw error('code, name and account_type are required');
  if (body.parent_id === body.id) throw error('Account cannot be its own parent');
  if (body.parent_id) {
    const [p] = await req.orgDb.query('SELECT id,parent_id FROM finance_accounts WHERE id=? AND is_active=1', { replacements: [body.parent_id] });
    if (!p[0]) throw error('Parent account not found', 404);
    const visited = new Set();
    let parentId = body.parent_id;
    while (parentId) {
      if (visited.has(parentId) || parentId === body.id) throw error('Account hierarchy contains a cycle', 409);
      visited.add(parentId);
      const [parents] = await req.orgDb.query('SELECT parent_id FROM finance_accounts WHERE id=? AND is_active=1', { replacements: [parentId] });
      parentId = parents[0]?.parent_id || null;
    }
  }
  const id = uuid();
  await req.orgDb.query('INSERT INTO finance_accounts(id,code,name,account_type,parent_id,normal_balance) VALUES(?,?,?,?,?,?)', { replacements: [id, body.code, body.name, body.account_type, body.parent_id || null, body.normal_balance || null] });
  return { id, code: body.code };
}

async function submitJournal(req, id, action) {
  const tx = await req.orgDb.transaction();
  try {
    const [rows] = await req.orgDb.query('SELECT * FROM finance_journals WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    if (!rows[0]) throw error('Journal not found', 404);
    const transitions = { submit: ['draft', 'submitted'], approve: ['submitted', 'approved'], post: ['approved', 'posted'] };
    if (!transitions[action] || rows[0].status !== transitions[action][0]) throw error(`Journal cannot be ${action}d`, 409);
    if (action === 'post') {
      const [period] = await req.orgDb.query('SELECT status FROM finance_periods WHERE ? BETWEEN starts_on AND ends_on FOR UPDATE', { replacements: [rows[0].journal_date], transaction: tx });
      if (!period[0]) throw error('No accounting period exists for this journal date', 409);
      if (period[0].status !== 'open') throw error('Cannot post into a closed period', 409);
      const [sum] = await req.orgDb.query('SELECT COALESCE(SUM(debit),0) debit,COALESCE(SUM(credit),0) credit FROM finance_journal_lines WHERE journal_id=?', { replacements: [id], transaction: tx });
      if (Number(sum[0].debit) !== Number(sum[0].credit)) throw error('Journal is not balanced', 409);
    }
    const next = transitions[action][1]; const actor = req.user?.sub || null;
    await req.orgDb.query(`UPDATE finance_journals SET status=?,${action === 'submit' ? 'submitted_by=?,submitted_at=NOW()' : action === 'approve' ? 'approved_by=?,approved_at=NOW()' : 'posted_at=NOW()'} WHERE id=?`, { replacements: action === 'post' ? [next, id] : [next, actor, id], transaction: tx });
    await req.orgDb.query(
    'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)',
    { replacements: [uuid(), actor, 'finance', `finance.journal.${action}`, 'journal', id, JSON.stringify({ from: rows[0].status, to: next }), req.ip || null], transaction: tx }
    );
    await tx.commit(); return { id, status: next };
  } catch (e) { await tx.rollback(); throw e; }
}

async function financialStatement(req, type, params = {}) {
  const aliases = { gl: 'trial_balance', general_ledger: 'trial_balance', pnl: 'profit_loss', pl: 'profit_loss', ar_ageing: 'receivables', ap_ageing: 'payables' };
  type = aliases[type] || type;
  const statementTypes = ['trial_balance', 'balance_sheet', 'income_statement', 'profit_loss', 'receivables', 'payables'];
  if (!statementTypes.includes(type)) throw error('Unsupported financial statement', 404);
  const [from, to] = range(params);
  const [rows] = await req.orgDb.query(
    'SELECT a.code,a.name,a.account_type,COALESCE(SUM(l.debit),0) debit,COALESCE(SUM(l.credit),0) credit FROM finance_accounts a LEFT JOIN (SELECT l.account_id,l.debit,l.credit FROM finance_journal_lines l INNER JOIN finance_journals j ON j.id=l.journal_id WHERE j.status="posted" AND j.journal_date BETWEEN ? AND ?) l ON l.account_id=a.id GROUP BY a.id ORDER BY a.code',
    { replacements: [from, to] }
  );
  const mapped = rows.map(r => {
    const debit = Number(r.debit || 0); const credit = Number(r.credit || 0);
    return { ...r, debit, credit, balance: ['asset', 'expense'].includes(String(r.account_type).toLowerCase()) ? debit - credit : credit - debit };
  });
  if (type === 'receivables' || type === 'payables') {
    const table = type === 'receivables' ? 'invoices' : 'finance_documents';
    const where = type === 'receivables' ? 'balance_amount > 0' : 'document_type="payable" AND status NOT IN ("paid","cancelled")';
    const [open] = await req.orgDb.query(`SELECT * FROM ${table} WHERE ${where} AND ${type === 'receivables' ? 'invoice_date' : 'document_date'} BETWEEN ? AND ? ORDER BY ${type === 'receivables' ? 'invoice_date' : 'document_date'}`, { replacements: [from, to] });
    return { statement: type, from, to, rows: open.map(r => ({ ...r, ageing_days: Math.max(0, Math.floor((Date.now() - new Date(r.due_date || r.invoice_date || r.document_date).getTime()) / 86400000)) })) };
  }
  return { statement: type, from, to, rows: type === 'income_statement' || type === 'profit_loss'
    ? mapped.filter(r => ['income', 'revenue', 'expense', 'cost'].includes(String(r.account_type).toLowerCase()))
    : mapped };
}

async function gstSnapshot(req, body) {
  if (!body.source_type || !body.source_id) throw error('source_type and source_id are required');
  const calculation = calculateGSTAuthoritative(body.items, body.org_state || req.org.state, body.customer_state);
  const tx = await req.orgDb.transaction();
  try {
    const [existing] = await req.orgDb.query('SELECT id,calculation FROM gst_context_snapshots WHERE source_type=? AND source_id=? FOR UPDATE', { replacements: [body.source_type, body.source_id], transaction: tx });
    if (existing[0]) { await tx.commit(); return { id: existing[0].id, calculation: typeof existing[0].calculation === 'string' ? JSON.parse(existing[0].calculation) : existing[0].calculation, already_exists: true }; }
    const id = uuid();
    await req.orgDb.query('INSERT INTO gst_context_snapshots(id,source_type,source_id,context,calculation) VALUES(?,?,?,?,?)', { replacements: [id, body.source_type, body.source_id, JSON.stringify({ org_state: body.org_state || req.org.state, customer_state: body.customer_state }), JSON.stringify(calculation)], transaction: tx });
    await req.orgDb.query('INSERT INTO gst_snapshots(id,source_type,source_id,calculation,taxable_amount,cgst,sgst,igst) VALUES(?,?,?,?,?,?,?,?)', { replacements: [uuid(), body.source_type, body.source_id, JSON.stringify(calculation), calculation.totals.taxable, calculation.totals.cgst, calculation.totals.sgst, calculation.totals.igst], transaction: tx });
    await tx.commit(); return { id, calculation };
  } catch (e) { await tx.rollback(); throw e; }
}

async function postPayrollToFinance(req, runId, body = {}) {
  const tx = await req.orgDb.transaction();
  try {
    const [runs] = await req.orgDb.query('SELECT * FROM payroll_runs WHERE id=? FOR UPDATE', { replacements: [runId], transaction: tx });
    if (!runs[0]) throw error('Payroll run not found', 404);
    if (!['approved', 'locked', 'processed'].includes(runs[0].status)) throw error('Payroll must be approved before posting', 409);
    const [posted] = await req.orgDb.query('SELECT id,journal_id FROM payroll_finance_posts WHERE payroll_run_id=?', { replacements: [runId], transaction: tx });
    if (posted[0]) { await tx.commit(); return { run_id: runId, journal_id: posted[0].journal_id, already_posted: true }; }
    const [accounts] = await req.orgDb.query('SELECT id,code FROM finance_accounts WHERE code IN (?,?)', { replacements: [body.expense_account_code || 'SALARY_EXPENSE', body.payable_account_code || 'SALARY_PAYABLE'], transaction: tx });
    const expense = accounts.find(a => a.code === (body.expense_account_code || 'SALARY_EXPENSE'));
    const payable = accounts.find(a => a.code === (body.payable_account_code || 'SALARY_PAYABLE'));
    if (!expense || !payable) throw error('Payroll posting accounts are not configured', 409);
    const [sum] = await req.orgDb.query('SELECT COALESCE(SUM(gross_amount),0) gross,COALESCE(SUM(net_amount),0) net FROM payroll_items WHERE payroll_run_id=?', { replacements: [runId], transaction: tx });
    const journalId = uuid(); const number = `PAYROLL-${runId}`;
    await req.orgDb.query('INSERT INTO finance_journals(id,journal_number,journal_date,narration,status,total_debit,created_by,approved_by,approved_at,posted_at) VALUES(?,?,?,?,?,?,?,?,NOW(),NOW())',
      { replacements: [journalId, number, runs[0].period_end || new Date().toISOString().slice(0, 10), `Payroll ${runs[0].period}`, 'posted', sum[0].gross, req.user?.sub || null, req.user?.sub || null], transaction: tx });
    await req.orgDb.query('INSERT INTO finance_journal_lines(id,journal_id,account_id,debit,credit) VALUES(?,?,?,?,?),(?,?,?,?,?)',
      { replacements: [uuid(), journalId, expense.id, sum[0].gross, 0, uuid(), journalId, payable.id, 0, sum[0].gross], transaction: tx });
    await req.orgDb.query('INSERT INTO payroll_finance_posts(id,payroll_run_id,journal_id) VALUES(?,?,?)', { replacements: [uuid(), runId, journalId], transaction: tx });
    await req.orgDb.query(
      'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [uuid(), req.user?.sub || null, 'payroll', 'payroll.post_to_finance', 'payroll_run', runId, JSON.stringify({ journal_id: journalId, amount: Number(sum[0].gross) }), req.ip || null], transaction: tx }
    );
    await tx.commit(); return { run_id: runId, journal_id: journalId, amount: Number(sum[0].gross) };
  } catch (e) { await tx.rollback(); throw e; }
}


async function recordAudit(req, moduleKey, action, referenceType, referenceId, changes = {}) {
  if (!req?.orgDb) return null;
  await req.orgDb.query(
    'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)',
    { replacements: [require('uuid').v4(), req.user?.sub || null, moduleKey, action, referenceType, referenceId, JSON.stringify(changes || {}), req.ip || null] }
  );
  return true;
}

async function withIdempotency(req, operation, work) {
  const key = req?.get ? req.get('Idempotency-Key') : null;
  if (!key) return work();
  const [rows] = await req.orgDb.query('SELECT response_json FROM domain_idempotency WHERE idempotency_key=? AND operation=? LIMIT 1', { replacements: [key, operation] });
  if (rows[0]) return JSON.parse(rows[0].response_json);
  const result = await work();
  await req.orgDb.query('INSERT INTO domain_idempotency(id,idempotency_key,operation,response_json) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE response_json=VALUES(response_json)',
    { replacements: [require('uuid').v4(), key, operation, JSON.stringify(result)] }
  );
  return result;
}

async function createQualitySpecification(req, body = {}) {
  if (!body.code || !body.name || !body.specification_type) throw error('code, name and specification_type are required');
  const id = require('uuid').v4();
  const record = { ...body, id, version_no: Number(body.version_no || 1), status: body.status || 'draft', effective_from: body.effective_from || new Date().toISOString().slice(0, 10), specification: body.specification || {} };
  const result = await withIdempotency(req, 'quality.specification.create', async () => {
    await req.orgDb.query('INSERT INTO quality_specifications(id,code,name,specification_type,version_no,effective_from,status,specification,approved_by,approved_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      { replacements: [id, record.code, record.name, record.specification_type, record.version_no, record.effective_from, record.status, JSON.stringify(record.specification), body.approved_by || null, body.approved_at || null, req.user?.sub || null] });
    await recordAudit(req, 'quality', 'quality.specification.create', 'quality_specification', id, record);
    return { id, ...record };
  });
  return result;
}

async function createQualityParameter(req, body = {}) {
  if (!body.specification_id || !body.parameter_code || !body.parameter_name) throw error('specification_id, parameter_code and parameter_name are required');
  const id = require('uuid').v4();
  const record = { ...body, id, is_active: body.is_active !== false ? 1 : 0 };
  const result = await withIdempotency(req, 'quality.parameter.create', async () => {
    await req.orgDb.query('INSERT INTO quality_parameters(id,specification_id,parameter_code,parameter_name,target_value,upper_limit,lower_limit,unit,is_active) VALUES(?,?,?,?,?,?,?,?,?)',
      { replacements: [id, record.specification_id, record.parameter_code, record.parameter_name, record.target_value || null, record.upper_limit ?? null, record.lower_limit ?? null, record.unit || null, record.is_active] });
    await recordAudit(req, 'quality', 'quality.parameter.create', 'quality_parameter', id, record);
    return { id, ...record };
  });
  return result;
}

async function createQualitySamplingPlan(req, body = {}) {
  if (!body.specification_id || !body.plan_code) throw error('specification_id and plan_code are required');
  const id = require('uuid').v4();
  const record = { ...body, id, sample_size: Number(body.sample_size || 0), is_active: body.is_active !== false ? 1 : 0 };
  const result = await withIdempotency(req, 'quality.sampling_plan.create', async () => {
    await req.orgDb.query('INSERT INTO quality_sampling_plans(id,specification_id,plan_code,sample_size,sampling_method,acceptance_level,is_active) VALUES(?,?,?,?,?,?,?)',
      { replacements: [id, record.specification_id, record.plan_code, record.sample_size, record.sampling_method || 'random', record.acceptance_level || null, record.is_active] });
    await recordAudit(req, 'quality', 'quality.sampling_plan.create', 'quality_sampling_plan', id, record);
    return { id, ...record };
  });
  return result;
}

async function createQualityAcceptanceCriteria(req, body = {}) {
  if (!body.specification_id || !body.criterion_code || !body.criterion_name) throw error('specification_id, criterion_code and criterion_name are required');
  const id = require('uuid').v4();
  const record = { ...body, id, status: body.status || 'active' };
  const result = await withIdempotency(req, 'quality.acceptance_criteria.create', async () => {
    await req.orgDb.query('INSERT INTO quality_acceptance_criteria(id,specification_id,criterion_code,criterion_name,expression,pass_threshold,status) VALUES(?,?,?,?,?,?,?)',
      { replacements: [id, record.specification_id, record.criterion_code, record.criterion_name, record.expression || null, record.pass_threshold ?? null, record.status] });
    await recordAudit(req, 'quality', 'quality.acceptance_criteria.create', 'quality_acceptance_criteria', id, record);
    return { id, ...record };
  });
  return result;
}

async function createInspectionSnapshot(req, inspectionId, payload = {}) {
  if (!inspectionId) throw error('inspection_id is required');
  const tx = await req.orgDb.transaction();
  try {
    const [rows] = await req.orgDb.query('SELECT COALESCE(MAX(snapshot_version),0) + 1 AS next_version FROM inspection_snapshots WHERE inspection_id=? FOR UPDATE', { replacements: [inspectionId], transaction: tx });
    const version = Number(rows[0]?.next_version || 1);
    const id = require('uuid').v4();
    const result = { id, inspection_id: inspectionId, snapshot_version: version, payload: payload || {} };
    await req.orgDb.query('INSERT INTO inspection_snapshots(id,inspection_id,snapshot_version,payload,recorded_by) VALUES(?,?,?,?,?)',
      { replacements: [id, inspectionId, version, JSON.stringify(payload || {}), req.user?.sub || null], transaction: tx });
    await req.orgDb.query(
      'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [require('uuid').v4(), req.user?.sub || null, 'quality', 'quality.inspection.snapshot', 'inspection', inspectionId, JSON.stringify(result), req.ip || null], transaction: tx }
    );
    await tx.commit();
    return result;
  } catch (e) { await tx.rollback(); throw e; }
}

async function createDepartment(req, body = {}) {
  if (!body.code || !body.name) throw error('code and name are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.department.create', async () => {
    await req.orgDb.query('INSERT INTO hr_departments(id,code,name,parent_id,location_id,is_active) VALUES(?,?,?,?,?,?)',
      { replacements: [id, body.code, body.name, body.parent_id || null, body.location_id || null, body.is_active !== false ? 1 : 0] });
    await recordAudit(req, 'hr', 'hr.department.create', 'department', id, body);
    return { id, code: body.code, name: body.name, parent_id: body.parent_id || null, location_id: body.location_id || null, is_active: body.is_active !== false ? 1 : 0 };
  });
  return result;
}
async function createHrMaster(req, kind, body = {}) {
  const definitions = {
    designation: ['hr_designations', 'code,name,description,is_active'],
    employment_type: ['hr_employment_types', 'code,name,is_active'],
    document_type: ['hr_document_types', 'code,name,document_sensitive,is_active']
  };
  const def = definitions[kind]; if (!def || !body.code || !body.name) throw error('code and name are required');
  const id = uuid();
  return withIdempotency(req, `hr.${kind}.create`, async () => {
    const values = kind === 'designation' ? [id, body.code, body.name, body.description || null, body.is_active === false ? 0 : 1]
      : kind === 'document_type' ? [id, body.code, body.name, body.sensitive ? 1 : 0, body.is_active === false ? 0 : 1]
        : [id, body.code, body.name, body.is_active === false ? 0 : 1];
    await req.orgDb.query(`INSERT INTO ${def[0]}(id,${def[1]}) VALUES(?,${values.slice(1).map(() => '?').join(',')})`, { replacements: values });
    await recordAudit(req, 'hr', `hr.${kind}.create`, kind, id, body);
    return { id, code: body.code, name: body.name };
  });
}

async function createLocation(req, body = {}) {
  if (!body.code || !body.name) throw error('code and name are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.location.create', async () => {
    await req.orgDb.query('INSERT INTO hr_locations(id,code,name,address,parent_id,is_active) VALUES(?,?,?,?,?,?)',
      { replacements: [id, body.code, body.name, body.address || null, body.parent_id || null, body.is_active !== false ? 1 : 0] });
    await recordAudit(req, 'hr', 'hr.location.create', 'location', id, body);
    return { id, code: body.code, name: body.name, address: body.address || null, parent_id: body.parent_id || null, is_active: body.is_active !== false ? 1 : 0 };
  });
  return result;
}

async function createGrade(req, body = {}) {
  if (!body.code || !body.name) throw error('code and name are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.grade.create', async () => {
    await req.orgDb.query('INSERT INTO hr_grades(id,code,name,pay_band,is_active) VALUES(?,?,?,?,?)',
      { replacements: [id, body.code, body.name, body.pay_band || 0, body.is_active !== false ? 1 : 0] });
    await recordAudit(req, 'hr', 'hr.grade.create', 'grade', id, body);
    return { id, code: body.code, name: body.name, pay_band: Number(body.pay_band || 0), is_active: body.is_active !== false ? 1 : 0 };
  });
  return result;
}

async function createShift(req, body = {}) {
  if (!body.code || !body.name) throw error('code and name are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.shift.create', async () => {
    await req.orgDb.query('INSERT INTO hr_shifts(id,code,name,start_time,end_time,work_hours,is_active) VALUES(?,?,?,?,?,?,?)',
      { replacements: [id, body.code, body.name, body.start_time || null, body.end_time || null, body.work_hours || 0, body.is_active !== false ? 1 : 0] });
    await recordAudit(req, 'hr', 'hr.shift.create', 'shift', id, body);
    return { id, code: body.code, name: body.name, start_time: body.start_time || null, end_time: body.end_time || null, work_hours: Number(body.work_hours || 0), is_active: body.is_active !== false ? 1 : 0 };
  });
  return result;
}

async function createCalendar(req, body = {}) {
  if (!body.code || !body.year) throw error('code and year are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.calendar.create', async () => {
    await req.orgDb.query('INSERT INTO hr_calendars(id,code,year,calendar_type,metadata,is_active) VALUES(?,?,?,?,?,?)',
      { replacements: [id, body.code, Number(body.year), body.calendar_type || 'annual', JSON.stringify(body.metadata || {}), body.is_active !== false ? 1 : 0] });
    await recordAudit(req, 'hr', 'hr.calendar.create', 'calendar', id, body);
    return { id, code: body.code, year: Number(body.year), calendar_type: body.calendar_type || 'annual', metadata: body.metadata || {}, is_active: body.is_active !== false ? 1 : 0 };
  });
  return result;
}

async function createAttendanceCorrection(req, body = {}) {
  if (!body.employee_id || !body.attendance_date || !body.proposed_status) throw error('employee_id, attendance_date and proposed_status are required');
  const id = require('uuid').v4();
  const record = { ...body, id, status: 'pending', original_status: body.original_status || 'present', reason: body.reason || null, requested_by: req.user?.sub || body.requested_by || null }
  const result = await withIdempotency(req, 'hr.attendance_correction.create', async () => {
    await req.orgDb.query('INSERT INTO attendance_corrections(id,employee_id,attendance_date,original_status,proposed_status,reason,requested_by,status) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [id, record.employee_id, record.attendance_date, record.original_status, record.proposed_status, record.reason, record.requested_by, record.status] });
    await recordAudit(req, 'hr', 'hr.attendance_correction.create', 'attendance_correction', id, record);
    return record;
  });
  return result;
}

async function createHoliday(req, body = {}) {
  if (!body.holiday_date || !body.holiday_name) throw error('holiday_date and holiday_name are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.holiday.create', async () => {
    await req.orgDb.query('INSERT INTO leave_holidays(id,holiday_date,holiday_name,is_recurring) VALUES(?,?,?,?)',
      { replacements: [id, body.holiday_date, body.holiday_name, body.is_recurring ? 1 : 0] });
    await recordAudit(req, 'hr', 'hr.holiday.create', 'holiday', id, body);
    return { id, holiday_date: body.holiday_date, holiday_name: body.holiday_name, is_recurring: body.is_recurring ? 1 : 0 };
  });
  return result;
}

async function createEmployeeHistory(req, body = {}) {
  if (!body.employee_id || !body.field_name || !body.effective_date) throw error('employee_id, field_name and effective_date are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.employee_history.create', async () => {
    await req.orgDb.query('INSERT INTO employee_history(id,employee_id,effective_date,field_name,old_value,new_value,changed_by) VALUES(?,?,?,?,?,?,?)',
      { replacements: [id, body.employee_id, body.effective_date, body.field_name, body.old_value || null, body.new_value || null, req.user?.sub || body.changed_by || null] });
    await recordAudit(req, 'hr', 'hr.employee_history.create', 'employee_history', id, body);
    return { id, employee_id: body.employee_id, effective_date: body.effective_date, field_name: body.field_name, old_value: body.old_value || null, new_value: body.new_value || null }
  });
  return result;
}

async function getEmployee360(req, employeeId) {
  if (!employeeId) throw error('employee_id is required');
  const [employeeRows] = await req.orgDb.query('SELECT * FROM employees WHERE id=? LIMIT 1', { replacements: [employeeId] });
  const employee = employeeRows[0];
  if (!employee) throw error('Employee not found', 404);
  const [historyRows] = await req.orgDb.query('SELECT * FROM employee_history WHERE employee_id=? ORDER BY created_at DESC LIMIT 50', { replacements: [employeeId] });
  const [deptRows] = employee.department_id ? await req.orgDb.query('SELECT * FROM hr_departments WHERE id=? LIMIT 1', { replacements: [employee.department_id] }) : [ [] ];
  const [locRows] = employee.location_id ? await req.orgDb.query('SELECT * FROM hr_locations WHERE id=? LIMIT 1', { replacements: [employee.location_id] }) : [ [] ];
  const [gradeRows] = employee.grade_id ? await req.orgDb.query('SELECT * FROM hr_grades WHERE id=? LIMIT 1', { replacements: [employee.grade_id] }) : [ [] ];
  const [shiftRows] = employee.shift_id ? await req.orgDb.query('SELECT * FROM hr_shifts WHERE id=? LIMIT 1', { replacements: [employee.shift_id] }) : [ [] ];
  const [attendanceRows] = await req.orgDb.query('SELECT * FROM attendance WHERE employee_id=? ORDER BY attendance_date DESC LIMIT 30', { replacements: [employeeId] });
  const [leaveRows] = await req.orgDb.query('SELECT * FROM leave_balances WHERE employee_id=? ORDER BY effective_date DESC LIMIT 20', { replacements: [employeeId] });
  const privileged = ['admin', 'superadmin', 'hr', 'payroll', 'finance'].includes(String(req.user?.role || '').toLowerCase());
  const safeEmployee = { ...employee };
  if (!privileged) for (const field of ['salary', 'basic_salary', 'bank_account', 'bank_account_number', 'pan', 'aadhaar', 'tax_id']) delete safeEmployee[field];
  return { employee: safeEmployee, department: deptRows[0] || null, location: locRows[0] || null, grade: gradeRows[0] || null, shift: shiftRows[0] || null, history: historyRows, attendance: attendanceRows, leave_balances: leaveRows };
}

async function approveAttendanceCorrection(req, id, body = {}) {
  if (!id) throw error('attendance correction id is required');
  const status = body.status || 'approved';
  if (!['approved', 'rejected'].includes(status)) throw error('status must be approved or rejected');
  const tx = await req.orgDb.transaction();
  try {
    const [rows] = await req.orgDb.query('SELECT * FROM attendance_corrections WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    const row = rows[0];
    if (!row) throw error('Attendance correction not found', 404);
    if (row.status !== 'pending') {
      await tx.commit();
      return { id, status: row.status, already_processed: true };
    }
    await req.orgDb.query('UPDATE attendance_corrections SET status=?,approved_by=?,approved_at=NOW() WHERE id=?',
      { replacements: [status, req.user?.sub || null, id], transaction: tx });
    if (status === 'approved') {
      await req.orgDb.query('UPDATE attendance SET status=?,corrected_by=?,approved_by=?,approved_at=NOW(),correction_status=? WHERE employee_id=? AND attendance_date=?',
        { replacements: [row.proposed_status, row.requested_by || null, req.user?.sub || null, 'approved', row.employee_id, row.attendance_date], transaction: tx });
    }
    await req.orgDb.query('INSERT INTO quality_ncr_events(id,ncr_id,event_type,actor_id,event_note) VALUES(?,?,?,?,?)',
      { replacements: [require('uuid').v4(), id, 'attendance_correction', req.user?.sub || null, `Attendance correction ${status}`], transaction: tx });
    await tx.commit();
    return { id, status, employee_id: row.employee_id, attendance_date: row.attendance_date };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function createLeavePolicy(req, body = {}) {
  if (!body.leave_type || !body.effective_from) throw error('leave_type and effective_from are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.leave_policy.create', async () => {
    await req.orgDb.query('INSERT INTO leave_policies(id,employee_id,leave_type,annual_days,carry_forward_days,max_accumulation,is_default,effective_from) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [id, body.employee_id || null, body.leave_type, Number(body.annual_days || 0), Number(body.carry_forward_days || 0), Number(body.max_accumulation || 0), body.is_default ? 1 : 0, body.effective_from] });
    await recordAudit(req, 'hr', 'hr.leave_policy.create', 'leave_policy', id, body);
    return { id, ...body, annual_days: Number(body.annual_days || 0), carry_forward_days: Number(body.carry_forward_days || 0), max_accumulation: Number(body.max_accumulation || 0) };
  });
  return result;
}

async function createLeaveAccrualRule(req, body = {}) {
  if (!body.leave_type || !body.accrual_period || !body.effective_from) throw error('leave_type, accrual_period and effective_from are required');
  const id = require('uuid').v4();
  const result = await withIdempotency(req, 'hr.leave_accrual.create', async () => {
    await req.orgDb.query('INSERT INTO leave_accrual_rules(id,leave_type,accrual_period,accrual_days,max_balance,effective_from,is_active) VALUES(?,?,?,?,?,?,?)',
      { replacements: [id, body.leave_type, body.accrual_period, Number(body.accrual_days || 0), Number(body.max_balance || 0), body.effective_from, body.is_active !== false ? 1 : 0] });
    await recordAudit(req, 'hr', 'hr.leave_accrual.create', 'leave_accrual_rule', id, body);
    return { id, ...body, accrual_days: Number(body.accrual_days || 0), max_balance: Number(body.max_balance || 0) };
  });
  return result;
}

async function approveLeaveRequest(req, id, body = {}) {
  const status = body.status || 'approved';
  if (!['approved', 'rejected'].includes(status)) throw error('status must be approved or rejected');
  const tx = await req.orgDb.transaction();
  try {
    const [rows] = await req.orgDb.query('SELECT * FROM leave_requests WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
    const leave = rows[0];
    if (!leave) throw error('Leave request not found', 404);
    if (leave.status !== 'pending') { await tx.commit(); return { ...leave, already_processed: true }; }
    let days = Number(leave.days || 0);
    if (status === 'approved' && !days) {
      const result = await validateLeaveRequest(req, leave);
      days = result.business_days;
    }
    await req.orgDb.query('UPDATE leave_requests SET status=?,approved_by=?,approved_at=NOW(),days=? WHERE id=?',
      { replacements: [status, req.user?.sub || null, days, id], transaction: tx });
    if (status === 'approved' && days > 0) {
      const [balanceRows] = await req.orgDb.query('SELECT * FROM leave_balances WHERE employee_id=? AND leave_type=? ORDER BY effective_date DESC LIMIT 1 FOR UPDATE',
        { replacements: [leave.employee_id, leave.leave_type || 'annual'], transaction: tx });
      const balance = Number(balanceRows[0]?.closing_balance || 0);
      if (balance < days) throw Object.assign(new Error('Leave balance is insufficient'), { status: 409, code: 'LEAVE_BALANCE_EXCEEDED' });
      await req.orgDb.query('UPDATE leave_balances SET used_days=used_days+?,closing_balance=closing_balance-? WHERE id=?',
        { replacements: [days, days, balanceRows[0].id], transaction: tx });
    }
    await recordAudit(req, 'hr', 'hr.leave.approval', 'leave_request', id, { status, days });
    await tx.commit();
    return { ...leave, id, status, approved_by: req.user?.sub || null, days };
  } catch (e) { await tx.rollback(); throw e; }
}

async function validateLeaveRequest(req, body = {}) {
  if (!body.employee_id || !body.from_date || !body.to_date) throw error('employee_id, from_date and to_date are required');
  const from = new Date(body.from_date); const to = new Date(body.to_date);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw error('Leave range is invalid');
  const [existing] = await req.orgDb.query('SELECT id, employee_id, from_date, to_date, status FROM leave_requests WHERE employee_id=? AND status NOT IN ("rejected","cancelled") AND from_date <= ? AND to_date >= ?',
    { replacements: [body.employee_id, body.to_date, body.from_date] });
  if (existing[0]) {
    throw Object.assign(new Error('Leave request overlaps with an existing approved or pending period'), { status: 409, code: 'LEAVE_OVERLAP' });
  }

  const [holidayRows] = await req.orgDb.query('SELECT holiday_date FROM leave_holidays WHERE holiday_date BETWEEN ? AND ?', { replacements: [body.from_date, body.to_date] });
  const holidaySet = new Set(holidayRows.map(r => r.holiday_date));
  let businessDays = 0;
  const cursor = new Date(from);
  while (cursor <= to) {
    const iso = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getDay();
    if (weekday !== 0 && weekday !== 6 && !holidaySet.has(iso)) businessDays += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  const balance = await getLeaveBalanceForEmployee(req, body.employee_id, body.leave_type || 'annual');
  if (Number(balance?.closing_balance || 0) < businessDays) {
    throw Object.assign(new Error('Leave balance is insufficient for the requested duration'), { status: 409, code: 'LEAVE_BALANCE_EXCEEDED' });
  }
  return { valid: true, business_days: businessDays, balance: Number(balance?.closing_balance || 0), overlaps: [], holiday_count: holidayRows.length };
}

async function getLeaveBalanceForEmployee(req, employeeId, leaveType = 'annual') {
  const [rows] = await req.orgDb.query('SELECT * FROM leave_balances WHERE employee_id=? AND leave_type=? ORDER BY effective_date DESC LIMIT 1', { replacements: [employeeId, leaveType] });
  return rows[0] || { employee_id: employeeId, leave_type: leaveType, opening_balance: 0, accrued_days: 0, used_days: 0, carry_forward_days: 0, closing_balance: 0 };
}

async function recordLeaveBalanceTransaction(req, body = {}) {
  if (!body.employee_id || !body.leave_type || !body.transaction_type || Number(body.quantity) === 0) throw error('employee_id, leave_type, transaction_type and quantity are required');
  const tx = await req.orgDb.transaction();
  try {
    const [balances] = await req.orgDb.query('SELECT * FROM leave_balances WHERE employee_id=? AND leave_type=? ORDER BY effective_date DESC LIMIT 1 FOR UPDATE', { replacements: [body.employee_id, body.leave_type], transaction: tx });
    const current = Number(balances[0]?.closing_balance || 0);
    const delta = Number(body.quantity || 0);
    const next = ['credit', 'accrual', 'carry_forward'].includes(body.transaction_type) ? current + delta : current - delta;
    if (next < 0) throw Object.assign(new Error('Leave balance cannot go negative'), { status: 409, code: 'LEAVE_BALANCE_INVALID' });
    const id = require('uuid').v4();
    await req.orgDb.query('INSERT INTO leave_balance_transactions(id,employee_id,leave_type,transaction_type,quantity,related_reference,reason,created_by) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [id, body.employee_id, body.leave_type, body.transaction_type, Math.abs(delta), body.related_reference || null, body.reason || null, req.user?.sub || null], transaction: tx });
    await req.orgDb.query('INSERT INTO leave_balances(id,employee_id,leave_type,opening_balance,accrued_days,used_days,carry_forward_days,closing_balance,effective_date) VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE opening_balance=VALUES(opening_balance),accrued_days=VALUES(accrued_days),used_days=VALUES(used_days),carry_forward_days=VALUES(carry_forward_days),closing_balance=VALUES(closing_balance),effective_date=VALUES(effective_date)',
      { replacements: [require('uuid').v4(), body.employee_id, body.leave_type, current, body.transaction_type === 'accrual' ? delta : 0, body.transaction_type === 'usage' ? delta : 0, body.transaction_type === 'carry_forward' ? delta : 0, next, new Date().toISOString().slice(0, 10)], transaction: tx });
    await req.orgDb.query(
      'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)',
      { replacements: [require('uuid').v4(), req.user?.sub || null, 'hr', 'hr.leave.balance_transaction', 'employee', body.employee_id, JSON.stringify({ leave_type: body.leave_type, transaction_type: body.transaction_type, quantity: delta, balance: next }), req.ip || null], transaction: tx }
    );
    await tx.commit();
    return { employee_id: body.employee_id, leave_type: body.leave_type, balance: next };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

async function transitionNcr(req, id, body = {}) {
  const status = body.status || 'investigating';
  const transitions = {
    open: ['investigating', 'rejected'],
    investigating: ['containment', 'approved', 'rejected'],
    containment: ['corrective_action', 'rejected'],
    corrective_action: ['verification', 'approved', 'rejected'],
    verification: ['closed', 'corrective_action', 'rejected'],
    approved: ['closed', 'verification', 'rejected'],
    rejected: ['open'],
    closed: []
  };
  if (!Object.prototype.hasOwnProperty.call(transitions, status) && !Object.values(transitions).flat().includes(status)) throw error('Invalid NCR status');
  const effectKey = `${id}:${status}:${body.root_cause || ''}:${body.corrective_action || ''}`;
  return withIdempotency(req, `quality.ncr.transition.${id}`, async () => {
    const tx = await req.orgDb.transaction();
    try {
      const [rows] = await req.orgDb.query('SELECT * FROM quality_ncrs WHERE id=? FOR UPDATE', { replacements: [id], transaction: tx });
      if (!rows[0]) throw error('NCR not found', 404);
      if (!transitions[rows[0].status]?.includes(status)) throw Object.assign(new Error(`NCR cannot transition from ${rows[0].status} to ${status}`), { status: 409, code: 'INVALID_NCR_TRANSITION' });
      if (['containment', 'corrective_action'].includes(status) && !(body.containment_action || rows[0].containment_action || body.corrective_action || rows[0].corrective_action)) throw error('Containment or corrective action details are required');
      if (status === 'approved' && !(body.root_cause || rows[0].root_cause)) throw error('Root cause is required before approval');
      if (status === 'verification' && !(body.verification_note || body.corrective_action || rows[0].corrective_action)) throw error('Verification evidence is required');
      if (status === 'closed' && !(body.corrective_action || rows[0].corrective_action)) throw error('Corrective action is required before closure');
      await req.orgDb.query(
        'UPDATE quality_ncrs SET status=?,root_cause=COALESCE(?,root_cause),containment_action=COALESCE(?,containment_action),corrective_action=COALESCE(?,corrective_action),verified_by=?,verified_at=?,closed_by=?,closed_at=? WHERE id=?',
        { replacements: [status, body.root_cause ?? null, body.containment_action ?? null, body.corrective_action ?? null, status === 'verification' ? (req.user?.sub || null) : null, status === 'verification' ? new Date() : null, status === 'closed' ? (req.user?.sub || null) : null, status === 'closed' ? new Date() : null, id], transaction: tx }
      );
      await req.orgDb.query('INSERT INTO quality_ncr_events(id,ncr_id,event_type,actor_id,event_note) VALUES(?,?,?,?,?)',
        { replacements: [require('uuid').v4(), id, 'status_change', req.user?.sub || null, `NCR transitioned to ${status}`], transaction: tx });
      const [nextRows] = await req.orgDb.query('SELECT * FROM quality_ncrs WHERE id=?', { replacements: [id], transaction: tx });
      await recordAudit(req, 'quality', 'quality.ncr.transition', 'ncr', id, { status, root_cause: body.root_cause || null, corrective_action: body.corrective_action || null, effect_key: effectKey });
      await tx.commit();
      return nextRows[0];
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  });
}

async function applyDispositionStockEffect(req, tx, inspectionId, disposition, quantity, warehouseId, itemId = null) {
  const qty = Number(quantity || 0);
  if (!inspectionId || !disposition || qty <= 0) throw error('inspection_id, disposition and positive quantity are required');
  const [inspectionRows] = await req.orgDb.query('SELECT id,item_id,inspected_qty,accepted_qty,rejected_qty FROM qc_inspections WHERE id=? LIMIT 1', { replacements: [inspectionId], transaction: tx });
  const inspection = inspectionRows[0] || {};
  const targetItemId = itemId || inspection.item_id || null;
  if (!targetItemId) throw error('Disposition cannot be applied without an item reference');
  const targetWarehouseId = warehouseId || null;
  const movement = ['quarantine', 'rework', 'scrap'].includes(disposition) ? 'out' : (disposition === 'return' ? 'in' : 'out');
  const [summaryRows] = await req.orgDb.query('SELECT current_qty FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [targetItemId, targetWarehouseId || ''], transaction: tx });
  const currentQty = Number(summaryRows[0]?.current_qty || 0);
  const nextQty = movement === 'out' ? currentQty - qty : currentQty + qty;
  if (movement === 'out' && nextQty < 0) throw Object.assign(new Error('Insufficient stock for disposition effect'), { status: 409, code: 'INSUFFICIENT_STOCK' });
  await req.orgDb.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,qty_out,balance_qty,notes,created_by,transaction_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,NOW())',
    { replacements: [require('uuid').v4(), targetItemId, targetWarehouseId, disposition, 'quality_disposition', inspectionId, movement === 'in' ? qty : 0, movement === 'out' ? qty : 0, nextQty, `Quality disposition: ${disposition}`, req.user?.sub || null], transaction: tx });
  if (summaryRows[0]) {
    await req.orgDb.query('UPDATE stock_summary SET current_qty=?,last_updated=NOW() WHERE item_id=? AND warehouse_id=?',
      { replacements: [nextQty, targetItemId, targetWarehouseId || ''], transaction: tx });
  } else {
    await req.orgDb.query('INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value,last_updated) VALUES(?,?,?,0,0,NOW())',
      { replacements: [targetItemId, targetWarehouseId || '', nextQty], transaction: tx });
  }
  return { item_id: targetItemId, warehouse_id: targetWarehouseId, balance_qty: nextQty, movement_type: movement };
}

async function disposeInspection(req, body) {
  if (!body.inspection_id || !body.disposition || Number(body.quantity) <= 0) throw error('inspection_id, disposition and positive quantity are required');
  const effectKey = `${body.inspection_id}:${body.disposition}:${body.quantity}:${body.batch_id || ''}:${body.serial_id || ''}`;
  return withIdempotency(req, `quality.disposition.${effectKey}`, async () => {
    const tx = await req.orgDb.transaction();
    try {
      const [existing] = await req.orgDb.query('SELECT id,effect_key FROM quality_dispositions WHERE effect_key=?', { replacements: [effectKey], transaction: tx });
      if (existing[0]) {
        await tx.commit();
        return { ...existing[0], already_applied: true, status: 'closed' };
      }
      const [inspectionRows] = await req.orgDb.query('SELECT * FROM qc_inspections WHERE id=? FOR UPDATE', { replacements: [body.inspection_id], transaction: tx });
      const inspection = inspectionRows[0];
      if (!inspection) throw error('Inspection not found', 404);
      const id = require('uuid').v4();
      const dispositionResult = await applyDispositionStockEffect(req, tx, body.inspection_id, body.disposition, body.quantity, body.warehouse_id || null, inspection.item_id || body.item_id || null);
      await req.orgDb.query('INSERT INTO quality_dispositions(id,inspection_id,disposition,quantity,warehouse_id,batch_id,serial_id,effect_key,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
        { replacements: [id, body.inspection_id, body.disposition, body.quantity, body.warehouse_id || null, body.batch_id || null, body.serial_id || null, effectKey, req.user?.sub || null], transaction: tx });
      await req.orgDb.query('INSERT INTO quality_disposition_effects(id,disposition_id,item_id,warehouse_id,disposition,quantity,movement_type,source_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
        { replacements: [require('uuid').v4(), id, inspection.item_id || body.item_id || null, body.warehouse_id || null, body.disposition, body.quantity, dispositionResult.movement_type, body.disposition, req.user?.sub || null], transaction: tx });
      await req.orgDb.query('UPDATE qc_inspections SET status=?,result=? WHERE id=?', { replacements: ['closed', body.disposition, body.inspection_id], transaction: tx });
      await recordAudit(req, 'quality', 'quality.disposition.create', 'quality_disposition', id, { inspection_id: body.inspection_id, disposition: body.disposition, quantity: body.quantity, stock_effect: dispositionResult });
      await tx.commit();
      return { id, effect_key: effectKey, status: 'closed', stock_effect: dispositionResult };
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  });
}

module.exports = { REPORTS, payrollSnapshot, calculateGSTAuthoritative, integrationBoundary, reportDefinition, range, createNcr, disposeInspection, finalizePayroll, report, getPayslip, closePeriod, reverseJournal, createFinanceDocument, reconcileBank, createBankTransaction, transitionExpense, recordVendorPayment, evaluateFormula, savePayrollComponent, recordPayrollOvertime, calculatePayroll, transitionPayroll, createAccount, submitJournal, financialStatement, gstSnapshot, postPayrollToFinance, createQualitySpecification, createQualityParameter, createQualitySamplingPlan, createQualityAcceptanceCriteria, createInspectionSnapshot, createDepartment, createHrMaster, createLocation, createGrade, createShift, createCalendar, createAttendanceCorrection, createHoliday, createEmployeeHistory, getEmployee360, approveAttendanceCorrection, createLeavePolicy, createLeaveAccrualRule, validateLeaveRequest, approveLeaveRequest, recordLeaveBalanceTransaction, transitionNcr };
