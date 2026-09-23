const { v4: uuid } = require('uuid');

const DEFINITIONS = {
  employees: {
    table: 'employees',
    module: 'hr',
    create: ['employee_code', 'name'],
    columns: [
      'employee_code',
      'name',
      'email',
      'department',
      'designation',
      'joining_date',
      'status',
      'salary',
    ],
  },
  quality: {
    table: 'qc_inspections',
    module: 'quality',
    create: ['inspection_number', 'source_type'],
    columns: [
      'inspection_number',
      'item_id',
      'source_type',
      'source_id',
      'inspected_by',
      'status',
      'result',
      'notes',
      'inspected_at',
    ],
  },
  payroll: {
    table: 'payroll_runs',
    module: 'payroll',
    create: ['run_number', 'period_start', 'period_end'],
    columns: [
      'run_number',
      'period_start',
      'period_end',
      'status',
      'total_amount',
      'processed_by',
    ],
  },
  accounts: {
    table: 'finance_accounts',
    module: 'finance',
    create: ['code', 'name', 'account_type'],
    columns: ['code', 'name', 'account_type', 'opening_balance', 'is_active'],
  },
  tax: {
    table: 'tax_transactions',
    module: 'gst',
    create: ['transaction_number', 'transaction_date'],
    columns: [
      'transaction_number',
      'transaction_date',
      'counterparty_gstin',
      'taxable_amount',
      'cgst',
      'sgst',
      'igst',
      'tax_type',
      'status',
    ],
  },
  attendance: {
    table: 'attendance',
    module: 'hr',
    create: ['employee_id', 'attendance_date'],
    columns: ['employee_id', 'attendance_date', 'status'],
  },
  leaves: {
    table: 'leave_requests',
    module: 'hr',
    create: ['employee_id', 'from_date', 'to_date'],
    columns: ['employee_id', 'from_date', 'to_date', 'days', 'status'],
  },
};

function assertInput(def, body) {
  for (const key of def.create)
    if (body[key] === undefined || body[key] === null || body[key] === '') {
      const error = new Error(`${key} is required`);
      error.status = 400;
      error.code = 'VALIDATION_ERROR';
      throw error;
    }
}
async function audit(db, req, action, referenceId, changes) {
  await db.query(
    'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)',
    {
      replacements: [
        uuid(),
        req.user?.sub || null,
        'next-domains',
        action,
        'domain',
        referenceId,
        JSON.stringify(changes || {}),
        req.ip,
      ],
      transaction: req.__domainTransaction,
    },
  );
}
async function idempotent(db, key, operation, work) {
  if (!key) return work();
  const [existing] = await db.query(
    'SELECT response_json FROM domain_idempotency WHERE idempotency_key=? AND operation=? LIMIT 1',
    { replacements: [key, operation] },
  );
  if (existing[0]) return JSON.parse(existing[0].response_json);
  // The write operation owns the idempotency insert so it can commit it in
  // the same transaction as the domain row and audit event.
  return work();
}
async function create(req, domain, body) {
  const def = DEFINITIONS[domain];
  assertInput(def, body);
  return idempotent(
    req.orgDb,
    req.get('Idempotency-Key'),
    `${domain}.create`,
    async () => {
      const tx = await req.orgDb.transaction();
      req.__domainTransaction = tx;
      try {
        const id = uuid();
        const values = def.columns.map((c) =>
          body[c] === undefined ? null : body[c],
        );
        if (domain === 'leaves' && values[3] == null)
          values[3] = Math.max(
            1,
            Math.floor(
              (new Date(body.to_date) - new Date(body.from_date)) / 86400000,
            ) + 1,
          );
        await req.orgDb.query(
          `INSERT INTO ${def.table}(id,${def.columns.join(',')}) VALUES(?,${def.columns.map(() => '?').join(',')})`,
          { replacements: [id, ...values], transaction: tx },
        );
        await audit(req.orgDb, req, `${domain}.create`, id, body);
        const result = {
          id,
          ...Object.fromEntries(def.columns.map((c, i) => [c, values[i]])),
        };
        if (req.get('Idempotency-Key')) {
          await req.orgDb.query(
            'INSERT INTO domain_idempotency(id,idempotency_key,operation,response_json) VALUES(?,?,?,?)',
            {
              replacements: [
                uuid(),
                req.get('Idempotency-Key'),
                `${domain}.create`,
                JSON.stringify(result),
              ],
              transaction: tx,
            },
          );
        }
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback();
        throw error;
      } finally {
        delete req.__domainTransaction;
      }
    },
  );
}
async function list(req, domain) {
  const def = DEFINITIONS[domain];
  const [rows] = await req.orgDb.query(
    `SELECT * FROM ${def.table} ORDER BY created_at DESC LIMIT 500`,
  );
  return rows;
}
async function update(req, domain, id, body) {
  const def = DEFINITIONS[domain];
  const fields = def.columns.filter((c) => body[c] !== undefined);
  if (!fields.length) return list(req, domain);
  const tx = await req.orgDb.transaction();
  req.__domainTransaction = tx;
  try {
    await req.orgDb.query(
      `UPDATE ${def.table} SET ${fields.map((c) => `${c}=?`).join(',')} WHERE id=?`,
      { replacements: [...fields.map((c) => body[c]), id], transaction: tx },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM ${def.table} WHERE id=?`,
      { replacements: [id], transaction: tx },
    );
    if (!rows[0]) {
      const e = new Error('Record not found');
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }
    await audit(req.orgDb, req, `${domain}.update`, id, body);
    await tx.commit();
    return rows[0];
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    delete req.__domainTransaction;
  }
}
async function transition(req, domain, id, status) {
  const allowed = {
    quality: ['pending', 'passed', 'failed', 'rework'],
    payroll: ['draft', 'processed', 'approved', 'paid'],
    accounts: ['draft', 'posted', 'reversed'],
    tax: ['draft', 'filed', 'reconciled'],
  };
  if (!allowed[domain]?.includes(status)) {
    const e = new Error('Invalid workflow status');
    e.status = 400;
    throw e;
  }
  const table = DEFINITIONS[domain].table;
  const tx = await req.orgDb.transaction();
  req.__domainTransaction = tx;
  try {
    const [current] = await req.orgDb.query(
      `SELECT id,status FROM ${table} WHERE id=? FOR UPDATE`,
      { replacements: [id], transaction: tx },
    );
    if (!current[0]) {
      const e = new Error('Record not found');
      e.status = 404;
      e.code = 'NOT_FOUND';
      throw e;
    }
    await req.orgDb.query(`UPDATE ${table} SET status=? WHERE id=?`, {
      replacements: [status, id],
      transaction: tx,
    });
    await audit(req.orgDb, req, `${domain}.transition`, id, { status });
    const [rows] = await req.orgDb.query(`SELECT * FROM ${table} WHERE id=?`, {
      replacements: [id],
      transaction: tx,
    });
    await tx.commit();
    return rows[0];
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    delete req.__domainTransaction;
  }
}
async function createJournal(req, body) {
  assertInput(
    { create: ['journal_number', 'journal_date'], columns: [] },
    body,
  );
  if (!Array.isArray(body.lines) || body.lines.length < 2)
    throw Object.assign(new Error('At least two journal lines are required'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  const debit = body.lines.reduce(
    (sum, line) => sum + Number(line.debit || 0),
    0,
  );
  const credit = body.lines.reduce(
    (sum, line) => sum + Number(line.credit || 0),
    0,
  );
  if (!Number.isFinite(debit) || Math.abs(debit - credit) > 0.005 || debit <= 0)
    throw Object.assign(new Error('Journal debits and credits must balance'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  const key = req.get?.('Idempotency-Key');
  if (key) {
    const [existing] = await req.orgDb.query(
      'SELECT response_json FROM domain_idempotency WHERE idempotency_key=? AND operation=? LIMIT 1',
      { replacements: [key, 'finance.journal.create'] },
    );
    if (existing[0]) return JSON.parse(existing[0].response_json);
  }
  for (const line of body.lines) {
    if (
      !line.account_id ||
      Number(line.debit || 0) < 0 ||
      Number(line.credit || 0) < 0 ||
      (Number(line.debit || 0) > 0 && Number(line.credit || 0) > 0)
    ) {
      throw Object.assign(
        new Error(
          'Each journal line must have one non-negative debit or credit account amount',
        ),
        { status: 400, code: 'VALIDATION_ERROR' },
      );
    }
  }
  const tx = await req.orgDb.transaction();
  const id = uuid();
  req.__domainTransaction = tx;
  try {
    await req.orgDb.query(
      'INSERT INTO finance_journals(id,journal_number,journal_date,narration,status,total_debit,created_by) VALUES(?,?,?,?,?,?,?)',
      {
        replacements: [
          id,
          body.journal_number,
          body.journal_date,
          body.narration || null,
          'draft',
          debit,
          req.user?.sub || null,
        ],
        transaction: tx,
      },
    );
    for (const line of body.lines)
      await req.orgDb.query(
        'INSERT INTO finance_journal_lines(id,journal_id,account_id,debit,credit) VALUES(?,?,?,?,?)',
        {
          replacements: [
            uuid(),
            id,
            line.account_id,
            Number(line.debit || 0),
            Number(line.credit || 0),
          ],
          transaction: tx,
        },
      );
    const result = {
      id,
      journal_number: body.journal_number,
      total_debit: debit,
      status: 'draft',
    };
    await audit(req.orgDb, req, 'finance.journal.create', id, { total: debit });
    if (key)
      await req.orgDb.query(
        'INSERT INTO domain_idempotency(id,idempotency_key,operation,response_json) VALUES(?,?,?,?)',
        {
          replacements: [
            uuid(),
            key,
            'finance.journal.create',
            JSON.stringify(result),
          ],
          transaction: tx,
        },
      );
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    delete req.__domainTransaction;
  }
}
module.exports = {
  DEFINITIONS,
  create,
  list,
  update,
  transition,
  assertInput,
  createJournal,
};
