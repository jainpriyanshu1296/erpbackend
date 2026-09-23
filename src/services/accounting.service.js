const { v4: uuid } = require('uuid');

const DEFAULT_ACCOUNTS = [
  ['1100', 'Accounts Receivable', 'asset'],
  ['1110', 'Cash/Bank', 'asset'],
  ['1200', 'Inventory', 'asset'],
  ['2100', 'Accounts Payable', 'liability'],
  ['2200', 'Output CGST', 'liability'],
  ['2210', 'Output SGST', 'liability'],
  ['2220', 'Output IGST', 'liability'],
  ['2230', 'Input CGST', 'asset'],
  ['2240', 'Input SGST', 'asset'],
  ['2250', 'Input IGST', 'asset'],
  ['4000', 'Sales', 'income'],
  ['4010', 'Sales Returns', 'income'],
  ['5000', 'Purchase Returns', 'expense'],
];

async function account(db, code, transaction) {
  const [rows] = await db.query(
    'SELECT id FROM finance_accounts WHERE code=? FOR UPDATE',
    { replacements: [code], transaction },
  );
  if (rows.length) return rows[0].id;
  const item = DEFAULT_ACCOUNTS.find((a) => a[0] === code) || [
    code,
    code,
    'asset',
  ];
  const id = uuid();
  await db.query(
    'INSERT INTO finance_accounts(id,code,name,account_type,is_active) VALUES(?,?,?,?,1)',
    { replacements: [id, item[0], item[1], item[2]], transaction },
  );
  return id;
}

function line(accountId, debit = 0, credit = 0) {
  return {
    account_id: accountId,
    debit: Number(debit || 0),
    credit: Number(credit || 0),
  };
}

async function postJournal(
  db,
  { sourceType, sourceId, date, narration, lines, userId, transaction },
) {
  const [existing] = await db.query(
    'SELECT id FROM finance_journals WHERE source_type=? AND source_id=? FOR UPDATE',
    {
      replacements: [sourceType, sourceId],
      transaction,
    },
  );
  if (existing.length)
    return { journal_id: existing[0].id, already_applied: true };
  const debit = lines.reduce((n, l) => n + Number(l.debit || 0), 0);
  const credit = lines.reduce((n, l) => n + Number(l.credit || 0), 0);
  if (Math.round(debit * 100) !== Math.round(credit * 100))
    throw Object.assign(new Error('Accounting journal is not balanced'), {
      status: 500,
      code: 'UNBALANCED_JOURNAL',
    });
  const id = uuid();
  await db.query(
    'INSERT INTO finance_journals(id,journal_number,journal_date,narration,status,total_debit,created_by,source_type,source_id) VALUES(?,?,COALESCE(?,CURDATE()),?,?,?,? ,?,?)',
    {
      replacements: [
        id,
        `AUTO-${sourceType}-${sourceId}`,
        date || null,
        narration,
        'posted',
        debit,
        userId || null,
        sourceType,
        sourceId,
      ],
      transaction,
    },
  );
  for (const l of lines) {
    await db.query(
      'INSERT INTO finance_journal_lines(id,journal_id,account_id,debit,credit) VALUES(?,?,?,?,?)',
      {
        replacements: [uuid(), id, l.account_id, l.debit, l.credit],
        transaction,
      },
    );
  }
  await db.query(
    'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes) VALUES(?,?,?,?,?,?,?)',
    {
      replacements: [
        uuid(),
        userId || null,
        'finance',
        'journal.auto_posted',
        sourceType,
        sourceId,
        JSON.stringify({ journal_id: id, total: debit }),
      ],
      transaction,
    },
  );
  return { journal_id: id, already_applied: false };
}

async function taxSnapshot(
  db,
  {
    sourceType,
    sourceId,
    taxable = 0,
    cgst = 0,
    sgst = 0,
    igst = 0,
    journalId,
    context = {},
    direction = 'credit',
    transaction,
  },
) {
  const [existing] = await db.query(
    'SELECT id FROM gst_context_snapshots WHERE source_type=? AND source_id=? FOR UPDATE',
    {
      replacements: [sourceType, sourceId],
      transaction,
    },
  );
  if (existing.length) return existing[0].id;
  const id = uuid();
  const calculation = {
    taxable: Number(taxable),
    cgst: Number(cgst),
    sgst: Number(sgst),
    igst: Number(igst),
  };
  await db.query(
    'INSERT INTO gst_context_snapshots(id,source_type,source_id,context,calculation,journal_id) VALUES(?,?,?,?,?,?)',
    {
      replacements: [
        id,
        sourceType,
        sourceId,
        JSON.stringify(context),
        JSON.stringify(calculation),
        journalId || null,
      ],
      transaction,
    },
  );
  const taxes = [
    ['cgst', cgst, direction],
    ['sgst', sgst, direction],
    ['igst', igst, direction],
  ];
  for (const [type, amount, direction] of taxes)
    if (Number(amount)) {
      await db.query(
        'INSERT INTO gst_ledger_entries(id,snapshot_id,tax_type,amount,direction) VALUES(?,?,?,?,?)',
        {
          replacements: [uuid(), id, type, amount, direction],
          transaction,
        },
      );
    }
  return id;
}

async function postInvoiceEffect(db, invoiceId, userId, transaction) {
  const [rows] = await db.query(
    'SELECT * FROM invoices WHERE id=? FOR UPDATE',
    { replacements: [invoiceId], transaction },
  );
  if (!rows.length)
    throw Object.assign(new Error('Invoice not found'), {
      status: 404,
      code: 'NOT_FOUND',
    });
  const invoice = rows[0];
  const [items] = await db.query(
    'SELECT taxable,cgst,sgst,igst,total FROM invoice_item_lines WHERE invoice_id=?',
    { replacements: [invoiceId], transaction },
  );
  const totals = items.reduce(
    (a, x) => ({
      taxable: a.taxable + Number(x.taxable || 0),
      cgst: a.cgst + Number(x.cgst || 0),
      sgst: a.sgst + Number(x.sgst || 0),
      igst: a.igst + Number(x.igst || 0),
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0 },
  );
  if (!items.length) totals.taxable = Number(invoice.total_amount || 0);
  const ar = await account(db, '1100', transaction),
    sales = await account(db, '4000', transaction);
  const output = [
    await account(db, '2200', transaction),
    await account(db, '2210', transaction),
    await account(db, '2220', transaction),
  ];
  const journal = await postJournal(db, {
    sourceType: 'invoice',
    sourceId: invoiceId,
    date: invoice.invoice_date,
    narration: `Invoice ${invoice.invoice_number}`,
    userId,
    transaction,
    lines: [
      line(ar, Number(invoice.total_amount || 0), 0),
      line(sales, 0, totals.taxable),
      line(output[0], 0, totals.cgst),
      line(output[1], 0, totals.sgst),
      line(output[2], 0, totals.igst),
    ],
  });
  const snapshot = await taxSnapshot(db, {
    sourceType: 'invoice',
    sourceId: invoiceId,
    ...totals,
    journalId: journal.journal_id,
    context: { invoice_number: invoice.invoice_number },
    direction: 'credit',
    transaction,
  });
  return { ...journal, tax_snapshot_id: snapshot };
}

async function postPaymentEffect(
  db,
  paymentId,
  invoiceId,
  amount,
  method,
  userId,
  transaction,
) {
  const cash = await account(
    db,
    method === 'cash' ? '1110' : '1110',
    transaction,
  );
  const ar = await account(db, '1100', transaction);
  const journal = await postJournal(db, {
    sourceType: 'payment',
    sourceId: paymentId,
    narration: `Payment for invoice ${invoiceId}`,
    userId,
    transaction,
    lines: [line(cash, amount, 0), line(ar, 0, amount)],
  });
  const snapshot = await taxSnapshot(db, {
    sourceType: 'payment',
    sourceId: paymentId,
    context: { invoice_id: invoiceId, method },
    journalId: journal.journal_id,
    transaction,
  });
  return { ...journal, tax_snapshot_id: snapshot };
}

// Purchases use finance_documents because vendor invoices are deliberately
// independent from the sales invoice workflow.
async function postVendorInvoiceEffect(db, documentId, userId, transaction) {
  const [rows] = await db.query(
    'SELECT * FROM finance_documents WHERE id=? FOR UPDATE',
    { replacements: [documentId], transaction },
  );
  if (!rows.length)
    throw Object.assign(new Error('Payable document not found'), {
      status: 404,
      code: 'NOT_FOUND',
    });
  const doc = rows[0];
  const amount = Number(doc.amount || 0);
  const taxable = Number(doc.taxable_amount ?? amount);
  const cgst = Number(doc.cgst || 0),
    sgst = Number(doc.sgst || 0),
    igst = Number(doc.igst || 0);
  const payable = await account(db, '2100', transaction);
  const purchase = await account(db, '1200', transaction);
  const inputs = [
    await account(db, '2230', transaction),
    await account(db, '2240', transaction),
    await account(db, '2250', transaction),
  ];
  const journal = await postJournal(db, {
    sourceType: 'vendor_invoice',
    sourceId: documentId,
    date: doc.document_date,
    narration: `Vendor invoice ${doc.document_number}`,
    userId,
    transaction,
    lines: [
      line(purchase, taxable, 0),
      line(inputs[0], cgst, 0),
      line(inputs[1], sgst, 0),
      line(inputs[2], igst, 0),
      line(payable, 0, amount),
    ],
  });
  const snapshot = await taxSnapshot(db, {
    sourceType: 'vendor_invoice',
    sourceId: documentId,
    taxable,
    cgst,
    sgst,
    igst,
    journalId: journal.journal_id,
    context: { document_number: doc.document_number, vendor_id: doc.party_id },
    direction: 'debit',
    transaction,
  });
  return { ...journal, tax_snapshot_id: snapshot };
}

async function postVendorPaymentEffect(
  db,
  paymentId,
  documentId,
  amount,
  method,
  userId,
  transaction,
) {
  const cash = await account(db, '1110', transaction);
  const payable = await account(db, '2100', transaction);
  return postJournal(db, {
    sourceType: 'vendor_payment',
    sourceId: paymentId,
    narration: `Payment for payable ${documentId}`,
    userId,
    transaction,
    lines: [line(payable, amount, 0), line(cash, 0, amount)],
  });
}

async function postBankEffect(
  db,
  bankId,
  {
    accountCode = '1110',
    amount,
    direction,
    contraAccountCode = '1100',
    userId,
    date,
    narration,
  },
  transaction,
) {
  const bank = await account(db, accountCode, transaction);
  const contra = await account(db, contraAccountCode, transaction);
  const value = Number(amount);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !['receipt', 'payment', 'transfer_in', 'transfer_out'].includes(direction)
  ) {
    throw Object.assign(new Error('Invalid bank transaction'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const receipt = direction === 'receipt' || direction === 'transfer_in';
  return postJournal(db, {
    sourceType: 'bank_transaction',
    sourceId: bankId,
    date,
    narration: narration || `Bank ${direction}`,
    userId,
    transaction,
    lines: receipt
      ? [line(bank, value, 0), line(contra, 0, value)]
      : [line(contra, value, 0), line(bank, 0, value)],
  });
}

async function postReturnEffect(
  db,
  type,
  id,
  amount,
  userId,
  transaction,
  tax = {},
) {
  const arOrPayable = await account(
    db,
    type === 'sales' ? '1100' : '2100',
    transaction,
  );
  const revenue = await account(
    db,
    type === 'sales' ? '4010' : '5000',
    transaction,
  );
  const journal = await postJournal(db, {
    sourceType: `${type}_return`,
    sourceId: id,
    narration: `${type} return ${id}`,
    userId,
    transaction,
    lines:
      type === 'sales'
        ? [line(revenue, amount, 0), line(arOrPayable, 0, amount)]
        : [line(arOrPayable, amount, 0), line(revenue, 0, amount)],
  });
  const snapshot = await taxSnapshot(db, {
    sourceType: `${type}_return`,
    sourceId: id,
    taxable: tax.taxable ?? amount,
    cgst: tax.cgst || 0,
    sgst: tax.sgst || 0,
    igst: tax.igst || 0,
    journalId: journal.journal_id,
    context: { type },
    direction: type === 'sales' ? 'debit' : 'credit',
    transaction,
  });
  return { ...journal, tax_snapshot_id: snapshot };
}

module.exports = {
  postInvoiceEffect,
  postVendorInvoiceEffect,
  postPaymentEffect,
  postVendorPaymentEffect,
  postBankEffect,
  postReturnEffect,
};
