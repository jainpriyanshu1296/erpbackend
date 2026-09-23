const express = require('express');
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, created, fail, asyncHandler } = require('../utils/response');
const { v4: uuid } = require('uuid');
const { transition, dispatch, completeWorkOrder, issueMaterials, transitionJobCard } = require('../services/salesProduction.service');

const sales = express.Router();
sales.use(auth, orgContext, entitlement, moduleGuard('sales'));
sales.get('/customers', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const search = String(req.query.search || '').trim();
  const where = search ? ' WHERE company_name LIKE ? OR customer_code LIKE ? OR email LIKE ?' : '';
  const replacements = search ? [`%${search}%`, `%${search}%`, `%${search}%`, limit, offset] : [limit, offset];
  const [[count]] = await req.orgDb.query(`SELECT COUNT(*) AS total FROM customers${where}`, { replacements: search ? replacements.slice(0, 3) : [] });
  const [rows] = await req.orgDb.query(`SELECT id,customer_code,company_name,contact_person,phone,email,gstin,state,is_active,created_at FROM customers${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, { replacements });
  return ok(res, rows, 'Customers fetched', { limit, offset, total: Number(count.total || 0) });
}));
sales.get('/customers/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query('SELECT * FROM customers WHERE id=? LIMIT 1', { replacements: [req.params.id] });
  if (!rows.length) return fail(res, 404, 'NOT_FOUND', 'Customer not found');
  return ok(res, rows[0]);
}));
sales.get('/customers/:id/360', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const [[customer]] = await req.orgDb.query('SELECT * FROM customers WHERE id=? LIMIT 1', { replacements: [id] });
  if (!customer) return fail(res, 404, 'NOT_FOUND', 'Customer not found');
  const [[summary]] = await req.orgDb.query(`SELECT
    (SELECT COUNT(*) FROM quotations WHERE customer_id=?) quotations,
    (SELECT COUNT(*) FROM sales_orders WHERE customer_id=?) orders,
    (SELECT COUNT(*) FROM invoices WHERE customer_id=?) invoices,
    (SELECT COALESCE(SUM(total_amount),0) FROM invoices WHERE customer_id=?) invoiced_amount,
    (SELECT COALESCE(SUM(balance_amount),0) FROM invoices WHERE customer_id=?) outstanding_amount`, { replacements: [id, id, id, id, id] });
  const [timeline] = await req.orgDb.query(`SELECT created_at,event_type,reference_id,description FROM (
    SELECT created_at,'quotation' event_type,id reference_id,CONCAT('Quotation ',status) description FROM quotations WHERE customer_id=?
    UNION ALL SELECT created_at,'sales_order',id,CONCAT('Sales order ',status) FROM sales_orders WHERE customer_id=?
    UNION ALL SELECT created_at,'invoice',id,CONCAT('Invoice ',status) FROM invoices WHERE customer_id=?
  ) events ORDER BY created_at DESC LIMIT 100`, { replacements: [id, id, id] });
  return ok(res, { customer, summary, timeline });
}));
sales.post('/customers', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { company_name } = req.body;
  if (!company_name) return fail(res, 400, 'VALIDATION_ERROR', 'company_name is required');
  const id = req.body.id || uuid();
  await req.orgDb.query('INSERT INTO customers(id,customer_code,company_name,contact_person,phone,email,gstin,state,address,payment_terms) VALUES(?,?,?,?,?,?,?,?,?,?)', { replacements: [id, req.body.customer_code || null, company_name, req.body.contact_person || null, req.body.phone || null, req.body.email || null, req.body.gstin || null, req.body.state || null, req.body.address || null, req.body.payment_terms || 30] });
  return created(res, { id, company_name });
}));
for (const [path, table] of [['quotations', 'quotations'], ['orders', 'sales_orders'], ['invoices', 'invoices']]) {
  sales.put(`/${path}/:id/status`, permission('sales', 'can_edit'), asyncHandler(async (req, res) => ok(res, await transition(req.orgDb, table, req.params.id, req.body.status, req.user.sub), 'Status updated')));
}
sales.put('/challans/:id/dispatch', permission('sales', 'can_edit'), asyncHandler(async (req, res) => ok(res, await dispatch(req.orgDb, req.params.id, req.body.warehouse_id, req.user.sub), 'Dispatch posted')));

const production = express.Router();
production.use(auth, orgContext, entitlement, moduleGuard('production'));
for (const [path,table,columns] of [['orders','production_orders',['production_number','item_id','status']],['bom','bom',['bom_code','finished_item_id','version_no']],['work-orders','work_orders',['wo_number','finished_item_id','status']],['job-cards','job_cards',['production_order_id','status']]]) {
  production.get(`/${path}`,permission('production','can_view'),asyncHandler(async(req,res)=>{
    const {page,limit,offset,search,sort,direction}=require('../utils/listQuery')(req.query,columns);
    const clauses=[],values=[];
    if(search){clauses.push(`(${columns.map(column=>`CAST(${column} AS CHAR) LIKE ?`).join(' OR ')})`);values.push(...columns.map(()=>`%${search}%`));}
    if(req.query.status && columns.includes('status')){clauses.push('status=?');values.push(req.query.status);}
    if(req.query.status && table==='bom'){clauses.push('is_active=?');values.push(req.query.status==='active'?1:0);}
    const where=clauses.length?` WHERE ${clauses.join(' AND ')}`:'';
    const [[count]]=await req.orgDb.query(`SELECT COUNT(*) total FROM ${table}${where}`,{replacements:values});
    const [rows]=await req.orgDb.query(`SELECT *${table==='bom'?",CASE WHEN is_active=1 THEN 'active' ELSE 'archived' END status":''} FROM ${table}${where} ORDER BY ${sort} ${direction},id LIMIT ? OFFSET ?`,{replacements:[...values,limit,offset]});
    return ok(res,rows,'Records fetched',{page,limit,total:Number(count.total)});
  }));
  if(path!=='orders') production.get(`/${path}/:id`,permission('production','can_view'),asyncHandler(async(req,res)=>{
    const [[row]]=await req.orgDb.query(`SELECT * FROM ${table} WHERE id=?`,{replacements:[req.params.id]});
    return row?ok(res,row):fail(res,404,'NOT_FOUND','Record not found');
  }));
}
production.post('/orders/:id/release',permission('production','can_edit'),asyncHandler(async(req,res)=>ok(res,await require('../services/salesProduction.service').releaseProductionOrder(req.orgDb,req.params.id,req.user.sub))));
production.post('/bom',permission('production','can_create'),asyncHandler(async(req,res)=>{
  const {bom_code,finished_item_id,output_qty}=req.body;
  if(!bom_code || !finished_item_id || !Number.isFinite(Number(output_qty)) || Number(output_qty)<=0) return fail(res,400,'VALIDATION_ERROR','BOM code, finished item and positive output quantity are required');
  const [[item]]=await req.orgDb.query('SELECT id FROM item_master WHERE id=? AND is_active=1',{replacements:[finished_item_id]});
  if(!item) return fail(res,400,'VALIDATION_ERROR','An active Item Master record is required');
  const id=uuid();
  await req.orgDb.query('INSERT INTO bom(id,bom_code,finished_item_id,output_qty,version_no,is_active,created_by) VALUES(?,?,?,?,1,1,?)',{replacements:[id,bom_code,finished_item_id,Number(output_qty),req.user.sub]});
  return created(res,{id,bom_code,finished_item_id,output_qty:Number(output_qty),version_no:1});
}));
production.get('/reports', permission('production','can_view'), asyncHandler(async (req,res) => {
  const {page,limit,offset,search,sort,direction} = require('../utils/listQuery')(req.query,['wo_number','planned_qty','produced_qty','status']);
  const where = search ? ' WHERE wo_number LIKE ? OR status LIKE ?' : '', values = search ? [`%${search}%`,`%${search}%`] : [];
  const [[count]] = await req.orgDb.query(`SELECT COUNT(*) total FROM work_orders${where}`,{replacements:values});
  const [rows] = await req.orgDb.query(`SELECT * FROM work_orders${where} ORDER BY ${sort} ${direction},id LIMIT ? OFFSET ?`,{replacements:[...values,limit,offset]});
  return ok(res,rows,'Production progress',{page,limit,total:Number(count.total)});
}));
production.post('/orders', permission('production', 'can_create'), asyncHandler(async (req, res) => {
  const { bom_id: bomId, item_id: itemId, planned_qty: plannedQty, so_id: salesOrderId } = req.body;
  if (!bomId || !itemId || !Number.isFinite(Number(plannedQty)) || Number(plannedQty) <= 0) return fail(res, 400, 'VALIDATION_ERROR', 'bom_id, item_id and a positive planned_qty are required');
  const id = uuid();
  await req.orgDb.query('INSERT INTO production_orders(id,production_number,so_id,bom_id,item_id,planned_qty,status,created_by) VALUES(?,?,?,?,?,?,?,?)', { replacements: [id, req.body.production_number || null, salesOrderId || null, bomId, itemId, Number(plannedQty), 'draft', req.user.sub] });
  return created(res, { id, bom_id: bomId, item_id: itemId, planned_qty: Number(plannedQty), status: 'draft' });
}));
production.get('/orders/:id', permission('production', 'can_view'), asyncHandler(async (req, res) => {
  const [[order]] = await req.orgDb.query('SELECT * FROM production_orders WHERE id=?', { replacements: [req.params.id] });
  if (!order) return fail(res, 404, 'NOT_FOUND', 'Production order not found');
  const [cards] = await req.orgDb.query('SELECT * FROM job_cards WHERE production_order_id=? ORDER BY created_at', { replacements: [req.params.id] });
  return ok(res, { ...order, job_cards: cards });
}));
production.put('/bom/:id/status', permission('production', 'can_edit'), asyncHandler(async (req, res) => {
  if(!['active','archived'].includes(req.body.status)) return fail(res,400,'VALIDATION_ERROR','BOM status must be active or archived');
  await req.orgDb.query('UPDATE bom SET is_active=? WHERE id=?',{replacements:[req.body.status==='active'?1:0,req.params.id]});
  return ok(res,{id:req.params.id,is_active:req.body.status==='active'?1:0});
}));
production.post('/work-orders',permission('production','can_create'),asyncHandler(async(req,res)=>{
  const {bom_id,finished_item_id,planned_qty}=req.body;
  const [[bom]]=await req.orgDb.query('SELECT id FROM bom WHERE id=? AND finished_item_id=? AND is_active=1',{replacements:[bom_id || null,finished_item_id || null]});
  if(!bom || !Number.isFinite(Number(planned_qty)) || Number(planned_qty)<=0) return fail(res,400,'VALIDATION_ERROR','A matching active BOM and positive planned quantity are required');
  const id=uuid();
  await req.orgDb.query("INSERT INTO work_orders(id,wo_number,bom_id,finished_item_id,planned_qty,status) VALUES(?,?,?,?,?,'draft')",{replacements:[id,req.body.wo_number || `WO-${id}`,bom_id,finished_item_id,Number(planned_qty)]});
  return created(res,{id,status:'draft'});
}));
production.post('/bom/:id/versions',permission('production','can_create'),asyncHandler(async(req,res)=>{
  if(!req.body.bom_code) return fail(res,400,'VALIDATION_ERROR','New version BOM code is required');
  const tx=await req.orgDb.transaction();
  try {
    const [[bom]]=await req.orgDb.query('SELECT * FROM bom WHERE id=? FOR UPDATE',{replacements:[req.params.id],transaction:tx});
    if(!bom) throw Object.assign(new Error('BOM not found'),{status:404});
    const [[existing]]=await req.orgDb.query('SELECT id FROM bom WHERE bom_code=?',{replacements:[req.body.bom_code],transaction:tx});
    if(existing) {await tx.commit();return ok(res,{id:existing.id,already_created:true});}
    const id=uuid();
    await req.orgDb.query('INSERT INTO bom(id,bom_code,finished_item_id,output_qty,version_no,is_active,created_by) VALUES(?,?,?,?,?,0,?)',{replacements:[id,req.body.bom_code,bom.finished_item_id,bom.output_qty,Number(bom.version_no || 1)+1,req.user.sub],transaction:tx});
    const [components]=await req.orgDb.query('SELECT * FROM bom_components WHERE bom_id=?',{replacements:[bom.id],transaction:tx});
    for(const component of components) await req.orgDb.query('INSERT INTO bom_components(id,bom_id,item_id,quantity,scrap_percent,rate) VALUES(?,?,?,?,?,?)',{replacements:[uuid(),id,component.item_id,component.quantity,component.scrap_percent,component.rate],transaction:tx});
    await req.orgDb.query("INSERT INTO related_documents(id,source_type,source_id,target_type,target_id,relation,created_by) VALUES(?,'bom',?,'bom',?,'version',?)",{replacements:[uuid(),bom.id,id,req.user.sub],transaction:tx});
    await tx.commit();return created(res,{id,bom_code:req.body.bom_code,version_no:Number(bom.version_no || 1)+1});
  }catch(cause){await tx.rollback();throw cause;}
}));
production.put('/work-orders/:id/status', permission('production', 'can_edit'), asyncHandler(async (req, res) => {
  if (req.body.status === 'completed') return ok(res, await completeWorkOrder(req.orgDb, req.params.id, req.body.warehouse_id, req.user.sub), 'Work order completed');
  return ok(res, await transition(req.orgDb, 'work_orders', req.params.id, req.body.status, req.user.sub), 'Work order status updated');
}));
production.post('/work-orders/:id/material-issue', permission('production', 'can_edit'), asyncHandler(async (req, res) => ok(res, await issueMaterials(req.orgDb, req.params.id, req.body.warehouse_id, req.user.sub, req.body.issue_key), 'Materials issued')));
production.put('/job-cards/:id/status', permission('production', 'can_edit'), asyncHandler(async (req, res) => ok(res, await transitionJobCard(req.orgDb, req.params.id, req.body.status, req.user.sub), 'Job card status updated')));
production.post('/mrp/calculate', permission('production', 'can_view'), asyncHandler(async (req, res) => {
  const demand = Number(req.body.demand || 0), onHand = Number(req.body.on_hand || 0), scheduled = Number(req.body.scheduled || 0), safety = Number(req.body.safety_stock || 0);
  if (![demand, onHand, scheduled, safety].every(Number.isFinite) || [demand, onHand, scheduled, safety].some(v => v < 0)) return fail(res, 400, 'VALIDATION_ERROR', 'MRP quantities must be non-negative numbers');
  return ok(res, { planned_quantity: Math.max(0, demand + safety - onHand - scheduled) });
}));
production.get('/dashboard', permission('production', 'can_view'), asyncHandler(async (req, res) => {
  const [[orders]] = await req.orgDb.query('SELECT COUNT(*) total FROM work_orders');
  const [[open]] = await req.orgDb.query("SELECT COUNT(*) total FROM work_orders WHERE status IN ('released','in_progress')");
  const [[cards]] = await req.orgDb.query("SELECT COUNT(*) total FROM job_cards WHERE status NOT IN ('completed','cancelled')");
  return ok(res, { work_orders: Number(orders.total || 0), open_work_orders: Number(open.total || 0), open_job_cards: Number(cards.total || 0) });
}));

module.exports = { sales, production };
