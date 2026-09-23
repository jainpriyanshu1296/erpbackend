const express = require('express');
const { v4: uuid } = require('uuid');
const { ok, created, fail, asyncHandler } = require('../utils/response');
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const allowed = /^[a-z][a-z0-9_]*$/;
function crud(table, module = 'dashboard', options = {}) {
  if (!allowed.test(table)) throw new Error('Unsafe table name');
  const r = express.Router(); r.use(auth, orgContext, moduleGuard(module));
  if (['work_orders','job_cards','bom'].includes(table)) r.use((req,res,next)=>['GET','HEAD'].includes(req.method)?next():fail(res,405,'PRODUCTION_WORKFLOW_REQUIRED','Use the validated production workflow'));
  if (table === 'invoices') r.use((req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : fail(res, 405, 'CANONICAL_INVOICE_REQUIRED', 'Use the sales invoice workflow to change invoices'));
  if (table === 'qc_inspections') r.use((req,res,next)=>['GET','HEAD'].includes(req.method)?next():fail(res,405,'VALIDATED_QC_REQUIRED','Use the Incoming, In-process, Final QC and result-processing workflows'));
  r.get('/', permission(module, 'can_view'), asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1)); const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where = search ? ' WHERE CAST(id AS CHAR) LIKE ?' : '';
    const replacements = search ? [`%${search}%`, limit, (page - 1) * limit] : [limit, (page - 1) * limit];
    const countReplacements = search ? [`%${search}%`] : [];
    const [[count]] = await req.orgDb.query(`SELECT COUNT(*) AS total FROM ${table}${where}`, { replacements: countReplacements });
    const [rows] = await req.orgDb.query(`SELECT * FROM ${table}${where} ORDER BY 1 DESC LIMIT ? OFFSET ?`, { replacements });
    return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
  }));
  if (options.create !== false) r.post('/', permission(module, 'can_create'), asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return fail(res, 400, 'VALIDATION_ERROR', 'A JSON object is required');
    const payload = { ...req.body, id: req.body.id || uuid() }; const keys = Object.keys(payload).filter(k => allowed.test(k));
    if (!keys.length) return fail(res, 400, 'VALIDATION_ERROR', 'At least one field is required');
    const vals = keys.map(k => payload[k]); await req.orgDb.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, { replacements: vals }); return created(res, payload);
  }));
  r.get('/:id', permission(module, 'can_view'), asyncHandler(async (req, res) => { const [rows] = await req.orgDb.query(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, { replacements: [req.params.id] }); return rows[0] ? ok(res, rows[0]) : fail(res, 404, 'NOT_FOUND', 'Record not found'); }));
  r.put('/:id', permission(module, 'can_edit'), asyncHandler(async (req, res) => { const keys = Object.keys(req.body).filter(k => allowed.test(k) && k !== 'id'); if (!keys.length) return fail(res, 400, 'VALIDATION_ERROR', 'No fields to update'); await req.orgDb.query(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(',')} WHERE id = ?`, { replacements: [...keys.map(k => req.body[k]), req.params.id] }); return ok(res, { id: req.params.id, ...req.body }, 'Updated successfully'); }));
  r.delete('/:id', permission(module, 'can_delete'), asyncHandler(async (req, res) => { await req.orgDb.query(`DELETE FROM ${table} WHERE id = ?`, { replacements: [req.params.id] }); return ok(res, null, 'Deleted successfully'); }));
  if (options.actions) for (const [path, method] of Object.entries(options.actions)) r[method || 'put'](`/:id/${path}`, permission(module, path === 'approve' ? 'can_approve' : 'can_edit'), asyncHandler(async (req, res) => { await req.orgDb.query(`UPDATE ${table} SET status = ? WHERE id = ?`, { replacements: [path.replace(/-/g, '_'), req.params.id] }); return ok(res, { id: req.params.id, status: path.replace(/-/g, '_') }, 'Status updated'); }));
  return r;
}
module.exports = crud;
