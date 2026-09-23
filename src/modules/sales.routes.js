const express = require('express');
const { v4: uuid } = require('uuid');
const { ok, fail, created, asyncHandler } = require('../utils/response');
const permission = require('../middleware/permission');

const router = express.Router();

// ============ QUOTATIONS ============

router.get('/quotations', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (search) {
    where += ' AND (q.quotation_number LIKE ? OR c.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ' AND q.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT q.*, c.company_name, c.customer_code
    FROM quotations q
    LEFT JOIN customers c ON c.id = q.customer_id
    ${where}
    ORDER BY q.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/quotations', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { customer_id, items, valid_until, notes } = req.body;
  
  if (!customer_id) return fail(res, 400, 'VALIDATION_ERROR', 'customer_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    const quantity=Number(item.quantity),rate=Number(item.rate),discount=Number(item.discount_percent || 0),gst=Number(item.gst_rate ?? 18);
    if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(rate) || rate < 0 || !Number.isFinite(discount) || discount<0 || discount>100 || !Number.isFinite(gst) || gst<0 || gst>100) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item needs valid quantity, rate, discount and GST values');
    }
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const [[customer]]=await req.orgDb.query('SELECT id FROM customers WHERE id=? AND is_active=1',{replacements:[customer_id],transaction:tx});
    if(!customer) throw Object.assign(new Error('Choose an active customer'),{status:400,code:'VALIDATION_ERROR'});
    const [validItems]=await req.orgDb.query('SELECT id FROM item_master WHERE id IN (?) AND is_active=1',{replacements:[items.map(item=>item.item_id)],transaction:tx});
    if(new Set(validItems.map(item=>item.id)).size!==new Set(items.map(item=>item.item_id)).size) throw Object.assign(new Error('Choose active Item Master records'),{status:400,code:'VALIDATION_ERROR'});
    const quotationId = uuid();
    const quotationNumber = `QT-${Date.now()}`;
    let totalAmount = 0;
    
    for (const item of items) {
      const qty = Number(item.quantity);
      const rate = Number(item.rate);
      const discount = Number(item.discount_percent || 0);
      const tax = Number(item.gst_rate ?? 18);
      
      const lineAmount = qty * rate * (1 - discount / 100);
      const lineTax = lineAmount * tax / 100;
      totalAmount += lineAmount + lineTax;
    }
    
    await req.orgDb.query(`
      INSERT INTO quotations(id, quotation_number, customer_id, status, valid_until, notes, total_amount, created_at)
      VALUES(?, ?, ?, 'draft', ?, ?, ?, NOW())
    `, {
      replacements: [quotationId, quotationNumber, customer_id, valid_until || null, notes || null, totalAmount],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO quotation_items(id, quotation_id, item_id, quantity, rate, discount_percent, gst_rate)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), quotationId, item.item_id, item.quantity, item.rate, item.discount_percent || 0, item.gst_rate ?? 18],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: quotationId, quotation_number: quotationNumber, status: 'draft', total_amount: totalAmount });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/quotations/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [quotation] = await req.orgDb.query(`
    SELECT q.*, c.company_name
    FROM quotations q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ?
  `, { replacements: [req.params.id] });
  
  if (!quotation.length) return fail(res, 404, 'NOT_FOUND', 'Quotation not found');
  
  const [items] = await req.orgDb.query(`
    SELECT qi.*, im.item_code, im.item_name
    FROM quotation_items qi
    LEFT JOIN item_master im ON im.id = qi.item_id
    WHERE qi.quotation_id = ?
  `, { replacements: [req.params.id] });
  
  return ok(res, { ...quotation[0], items });
}));

router.post('/quotations/:id/convert-to-order', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const result = await require('../services/salesProduction.service').createSalesOrderFromQuotation(req.orgDb, req.params.id);
  return result.already_converted ? ok(res, result, 'Sales order already exists') : created(res, result, 'Quotation converted to sales order');
}));

// ============ SALES ORDERS ============

router.get('/orders', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (search) {
    where += ' AND (so.so_number LIKE ? OR c.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ' AND so.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT so.*, c.company_name, c.customer_code
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    ${where}
    ORDER BY so.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/orders', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { customer_id, items, notes } = req.body;

  if (!customer_id) return fail(res, 400, 'VALIDATION_ERROR', 'customer_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }

  for (const item of items) {
    const quantity=Number(item.quantity),rate=Number(item.rate),discount=Number(item.discount_percent || 0),gst=Number(item.gst_rate ?? 18);
    if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(rate) || rate < 0 || !Number.isFinite(discount) || discount<0 || discount>100 || !Number.isFinite(gst) || gst<0 || gst>100) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item needs valid quantity, rate, discount and GST values');
    }
  }

  const tx = await req.orgDb.transaction();
  try {
    const [[customer]]=await req.orgDb.query('SELECT id FROM customers WHERE id=? AND is_active=1',{replacements:[customer_id],transaction:tx});
    if(!customer) throw Object.assign(new Error('Choose an active customer'),{status:400,code:'VALIDATION_ERROR'});
    const [validItems]=await req.orgDb.query('SELECT id FROM item_master WHERE id IN (?) AND is_active=1',{replacements:[items.map(item=>item.item_id)],transaction:tx});
    if(new Set(validItems.map(item=>item.id)).size!==new Set(items.map(item=>item.item_id)).size) throw Object.assign(new Error('Choose active Item Master records'),{status:400,code:'VALIDATION_ERROR'});
    const soId = uuid();
    const soNumber = `SO-${Date.now()}`;
    let totalAmount = 0;

    for (const item of items) {
      const qty = Number(item.quantity);
      const rate = Number(item.rate);
      const discount = Number(item.discount_percent || 0);
      const gst = Number(item.gst_rate ?? 18);
      const lineAmount = qty * rate * (1 - discount / 100);
      totalAmount += lineAmount + lineAmount * gst / 100;
    }

    await req.orgDb.query(`
      INSERT INTO sales_orders(id, so_number, customer_id, status, total_amount, notes, created_at)
      VALUES(?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [soId, soNumber, customer_id, totalAmount, notes || null],
      transaction: tx
    });

    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO sales_order_items(id, so_id, item_id, quantity, rate, discount_percent, gst_rate)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), soId, item.item_id, item.quantity, item.rate, item.discount_percent || 0, item.gst_rate ?? 18],
        transaction: tx
      });
    }

    await tx.commit();
    return created(res, { id: soId, so_number: soNumber, status: 'draft', total_amount: totalAmount });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/orders/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [order] = await req.orgDb.query(`
    SELECT so.*, c.company_name
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ?
  `, { replacements: [req.params.id] });
  
  if (!order.length) return fail(res, 404, 'NOT_FOUND', 'Sales order not found');
  
  const [items] = await req.orgDb.query(`
    SELECT soi.*, im.item_code, im.item_name
    FROM sales_order_items soi
    LEFT JOIN item_master im ON im.id = soi.item_id
    WHERE soi.so_id = ?
  `, { replacements: [req.params.id] });
  
  return ok(res, { ...order[0], items });
}));

router.post('/orders/:id/cancel', permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  const [order] = await req.orgDb.query('SELECT status FROM sales_orders WHERE id = ?', { replacements: [req.params.id] });
  if (!order.length) return fail(res, 404, 'NOT_FOUND', 'Sales order not found');
  
  if (!['draft', 'confirmed'].includes(order[0].status)) {
    return fail(res, 400, 'INVALID_STATE', 'Cannot cancel order in current status');
  }
  
  await req.orgDb.query('UPDATE sales_orders SET status = ? WHERE id = ?', {
    replacements: ['cancelled', req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'cancelled' }, 'Sales order cancelled');
}));

// ============ DELIVERY CHALLANS ============

router.get('/delivery-challans', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (status) {
    where += ' AND dc.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM delivery_challans dc ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT dc.*, c.company_name, so.so_number
    FROM delivery_challans dc
    LEFT JOIN customers c ON c.id = dc.customer_id
    LEFT JOIN sales_orders so ON so.id = dc.so_id
    ${where}
    ORDER BY dc.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/delivery-challans', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { customer_id, so_id, items, warehouse_id, delivery_date, notes } = req.body;
  
  if (!customer_id) return fail(res, 400, 'VALIDATION_ERROR', 'customer_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    if (!item.item_id || Number(item.quantity) <= 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id and positive quantity');
    }
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const challanId = uuid();
    const challanNumber = `DC-${Date.now()}`;
    
    await req.orgDb.query(`
      INSERT INTO delivery_challans(id, challan_number, customer_id, so_id, warehouse_id, status, delivery_date, notes, created_at)
      VALUES(?, ?, ?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [challanId, challanNumber, customer_id, so_id || null, warehouse_id || null, delivery_date || null, notes || null],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO delivery_challan_items(id, challan_id, item_id, quantity, rate)
        VALUES(?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), challanId, item.item_id, item.quantity, item.rate || 0],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: challanId, challan_number: challanNumber, status: 'draft' });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

// ============ SALES RETURNS ============

router.get('/returns', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  let where = 'WHERE 1=1';
  const replacements = [];

  if (search) {
    where += ' AND (sr.return_number LIKE ? OR c.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }

  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM sales_returns sr LEFT JOIN customers c ON c.id = sr.customer_id ${where}`,
    { replacements }
  );

  const [rows] = await req.orgDb.query(`
    SELECT sr.*, c.company_name
    FROM sales_returns sr
    LEFT JOIN customers c ON c.id = sr.customer_id
    ${where}
    ORDER BY sr.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });

  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/returns', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { customer_id, so_id, items, warehouse_id, reason, notes } = req.body;

  if (!customer_id) return fail(res, 400, 'VALIDATION_ERROR', 'customer_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }

  for (const item of items) {
    if (!item.item_id || Number(item.return_qty) <= 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id and positive return_qty');
    }
  }

  const tx = await req.orgDb.transaction();
  try {
    const [[customer]]=await req.orgDb.query('SELECT id FROM customers WHERE id=? AND is_active=1',{replacements:[customer_id],transaction:tx});
    const [[warehouse]]=await req.orgDb.query('SELECT id FROM warehouses WHERE id=? AND is_active=1',{replacements:[warehouse_id || null],transaction:tx});
    if(!customer || !warehouse) throw Object.assign(new Error('Choose an active customer and warehouse'),{status:400,code:'VALIDATION_ERROR'});
    if(so_id) {
      const [[order]]=await req.orgDb.query('SELECT id,customer_id FROM sales_orders WHERE id=? FOR UPDATE',{replacements:[so_id],transaction:tx});
      if(!order || order.customer_id!==customer_id) throw Object.assign(new Error('Sales order does not belong to this customer'),{status:409,code:'INVALID_RETURN'});
      for(const item of items) {
        const [[sent]]=await req.orgDb.query("SELECT COALESCE(SUM(dci.quantity),0) quantity FROM delivery_challan_items dci JOIN delivery_challans dc ON dc.id=dci.challan_id WHERE dc.so_id=? AND dci.item_id=? AND dc.status IN ('dispatched','delivered') FOR UPDATE",{replacements:[so_id,item.item_id],transaction:tx});
        const [[returned]]=await req.orgDb.query("SELECT COALESCE(SUM(sri.quantity),0) quantity FROM sales_return_items sri JOIN sales_returns sr ON sr.id=sri.return_id WHERE sr.so_id=? AND sri.item_id=? AND sr.status<>'cancelled' FOR UPDATE",{replacements:[so_id,item.item_id],transaction:tx});
        if(Number(returned.quantity)+Number(item.return_qty)>Number(sent.quantity)) throw Object.assign(new Error('Return quantity exceeds dispatched quantity'),{status:409,code:'INVALID_RETURN'});
      }
    }
    const returnId = uuid();
    const returnNumber = `SR-RET-${Date.now()}`;

    await req.orgDb.query(`
      INSERT INTO sales_returns(id, return_number, customer_id, so_id, warehouse_id, status, reason, notes, created_at)
      VALUES(?, ?, ?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [returnId, returnNumber, customer_id, so_id || null, warehouse_id || null, reason || null, notes || null],
      transaction: tx
    });

    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO sales_return_items(id, return_id, item_id, quantity, rate)
        VALUES(?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), returnId, item.item_id, item.return_qty, item.rate || 0],
        transaction: tx
      });
    }

    await tx.commit();
    return created(res, { id: returnId, return_number: returnNumber, status: 'draft' });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/returns/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [ret] = await req.orgDb.query(`
    SELECT sr.*, c.company_name
    FROM sales_returns sr
    LEFT JOIN customers c ON c.id = sr.customer_id
    WHERE sr.id = ?
  `, { replacements: [req.params.id] });

  if (!ret.length) return fail(res, 404, 'NOT_FOUND', 'Sales return not found');

  const [items] = await req.orgDb.query(`
    SELECT sri.*, im.item_code, im.item_name
    FROM sales_return_items sri
    LEFT JOIN item_master im ON im.id = sri.item_id
    WHERE sri.return_id = ?
  `, { replacements: [req.params.id] });

  return ok(res, { ...ret[0], items });
}));

router.post('/returns/:id/post', permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  const tx = await req.orgDb.transaction();
  try {
    const [ret] = await req.orgDb.query('SELECT status, warehouse_id FROM sales_returns WHERE id = ? FOR UPDATE', { replacements: [req.params.id],transaction:tx });
    if (!ret.length) { await tx.rollback(); return fail(res,404,'NOT_FOUND','Return not found'); }
    if (ret[0].status === 'posted') { await tx.commit(); return ok(res,{id:req.params.id,status:'posted',already_applied:true}); }
    if (ret[0].status !== 'draft') { await tx.rollback(); return fail(res,409,'INVALID_STATE','Only draft returns can be posted'); }
    const warehouseId = ret[0].warehouse_id;
    if (!warehouseId) {
      await tx.rollback();
      return fail(res, 400, 'MISSING_WAREHOUSE', 'Warehouse is required');
    }
    
    const [items] = await req.orgDb.query('SELECT * FROM sales_return_items WHERE return_id = ?', { replacements: [req.params.id], transaction: tx });

    if(!items.length) throw Object.assign(new Error('Return requires items'),{status:400,code:'VALIDATION_ERROR'});
    let total=0;
    for (const item of items) {
      const qty=Number(item.quantity),rate=Number(item.rate || 0);
      if(!Number.isFinite(qty)||qty<=0||!Number.isFinite(rate)||rate<0) throw Object.assign(new Error('Invalid return quantity or rate'),{status:400,code:'VALIDATION_ERROR'});
      total+=qty*rate;
      await require('../services/zeroGapClosure.service').applyStockEffect(req.orgDb,{operationKey:`sales-return:${req.params.id}:${item.id}`,referenceType:'sales_return',referenceId:req.params.id,itemId:item.item_id,warehouseId,quantity:qty,rate,direction:'in',userId:req.user.sub,transaction:tx});
    }
    await require('../services/accounting.service').postReturnEffect(req.orgDb,'sales',req.params.id,total,req.user.sub,tx);

    await req.orgDb.query('UPDATE sales_returns SET status = ?, posted_at = NOW() WHERE id = ?', {
      replacements: ['posted', req.params.id],
      transaction: tx
    });

    await tx.commit();
    return ok(res, { id: req.params.id, status: 'posted' }, 'Sales return posted and inventory updated');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/invoices', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const search = String(req.query.search || '').trim(), where = search ? ' WHERE i.invoice_number LIKE ? OR c.company_name LIKE ?' : '';
  const values = search ? [`%${search}%`, `%${search}%`] : [];
  const [[count]] = await req.orgDb.query(`SELECT COUNT(*) total FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id${where}`, { replacements: values });
  const [rows] = await req.orgDb.query(`SELECT i.*,c.company_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`, { replacements: [...values, limit, (page-1)*limit] });
  return ok(res, rows, 'Invoices fetched', { page, limit, total: Number(count.total || 0) });
}));
router.post('/invoices', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  return created(res, await require('../services/invoice.service').createInvoice(req.orgDb, { ...req.body, idempotency_key: req.get('Idempotency-Key') }, req.user.sub));
}));
router.post('/invoices/:id/issue', permission('sales','can_edit'), asyncHandler(async (req,res) => {
  return ok(res,await require('../services/salesProduction.service').transition(req.orgDb,'invoices',req.params.id,'issued',req.user.sub),'Invoice issued');
}));
router.get('/invoices/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [[invoice]] = await req.orgDb.query('SELECT i.*,c.company_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=?', { replacements:[req.params.id] });
  if (!invoice) return fail(res,404,'NOT_FOUND','Invoice not found');
  const [items] = await req.orgDb.query('SELECT * FROM invoice_item_lines WHERE invoice_id=? ORDER BY id', { replacements:[req.params.id] });
  const [payments] = await req.orgDb.query('SELECT * FROM invoice_payments WHERE invoice_id=? ORDER BY created_at DESC', { replacements:[req.params.id] });
  return ok(res,{ ...invoice,items,payments });
}));
router.post('/invoices/:id/payments', permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  const key=req.get('Idempotency-Key');
  if(!key) return fail(res,400,'IDEMPOTENCY_KEY_REQUIRED','Idempotency-Key is required');
  return created(res,await require('../services/erp.service').recordInvoicePayment(req.orgDb,req.params.id,req.body.amount,{...req.body,idempotency_key:`sales-payment:${key}`},req.user.sub));
}));
router.get('/payments', permission('sales','can_view'),asyncHandler(async(req,res)=>{
  const {page,limit,offset,search}=require('../utils/listQuery')(req.query,['created_at']);
  const where=search?' WHERE p.reference LIKE ? OR i.invoice_number LIKE ? OR c.company_name LIKE ?':'';
  const values=search?[`%${search}%`,`%${search}%`,`%${search}%`]:[];
  const from=' FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN customers c ON c.id=i.customer_id';
  const [[count]]=await req.orgDb.query(`SELECT COUNT(*) total${from}${where}`,{replacements:values});
  const [rows]=await req.orgDb.query(`SELECT p.*,i.invoice_number,c.company_name${from}${where} ORDER BY p.created_at DESC,p.id LIMIT ? OFFSET ?`,{replacements:[...values,limit,offset]});
  return ok(res,rows,'Payments fetched',{page,limit,total:Number(count.total)});
}));

router.post('/delivery-challans/:id/dispatch', permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  const result = await require('../services/salesProduction.service').dispatch(req.orgDb, req.params.id, req.body.warehouse_id, req.user.sub);
  result.invoice = await require('../services/automation.service').handleDeliveryChallanSaved(req.orgDb,req.params.id,req.user.sub);
  return ok(res, result, 'Delivery challan dispatched');
}));

module.exports = router;
