const { v4: uuid } = require('uuid');
const invalid = (message) =>
  Object.assign(new Error(message), { status: 400, code: 'VALIDATION_ERROR' });
async function requireInspectionSource(
  db,
  type,
  sourceId,
  itemId,
  transaction,
) {
  const queries = {
    incoming: [
      "SELECT g.id,g.warehouse_id,SUM(gi.quantity) quantity,SUM(gi.quantity*gi.rate)/NULLIF(SUM(gi.quantity),0) rate FROM grn g JOIN grn_items gi ON gi.grn_id=g.id AND gi.item_id=? WHERE g.id=? AND g.status='posted' GROUP BY g.id,g.warehouse_id",
      [itemId, sourceId],
    ],
    in_process: [
      'SELECT id,planned_qty quantity FROM work_orders WHERE id=? AND finished_item_id=? UNION ALL SELECT id,planned_qty quantity FROM production_orders WHERE id=? AND item_id=? UNION ALL SELECT jc.id,jc.planned_qty quantity FROM job_cards jc JOIN production_orders po ON po.id=jc.production_order_id WHERE jc.id=? AND po.item_id=? LIMIT 1',
      [sourceId, itemId, sourceId, itemId, sourceId, itemId],
    ],
    final: [
      "SELECT id,quantity,warehouse_id FROM production_outputs WHERE id=? AND item_id=? AND status='posted'",
      [sourceId, itemId],
    ],
  };
  if (!queries[type]) throw invalid('Unsupported inspection source');
  const [rows] = await db.query(queries[type][0], {
    replacements: queries[type][1],
    transaction,
  });
  if (!rows.length)
    throw invalid(
      'Inspection source must contain the selected item; incoming sources must be posted GRNs',
    );
  return rows[0];
}
function quantities(inspected, accepted, rejected) {
  const values = [inspected, accepted, rejected].map(Number);
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    values[0] <= 0 ||
    Math.abs(values[1] + values[2] - values[0]) > 0.000001
  )
    throw invalid(
      'Accepted and rejected quantities must be non-negative and sum to inspected quantity',
    );
  return { inspected: values[0], accepted: values[1], rejected: values[2] };
}
async function processResult(db, id, body, userId) {
  const tx = await db.transaction();
  try {
    const query = (sql, replacements = []) =>
      db.query(sql, { replacements, transaction: tx });
    const [[inspection]] = await query(
      'SELECT * FROM qc_inspections WHERE id=? FOR UPDATE',
      [id],
    );
    if (!inspection) throw invalid('Inspection not found');
    const key = `quality-result:${id}`;
    const [[existing]] = await query(
      'SELECT result_json FROM operation_keys WHERE operation_key=?',
      [key],
    );
    if (existing) {
      const saved =
        typeof existing.result_json === 'string'
          ? JSON.parse(existing.result_json)
          : existing.result_json;
      for (const field of ['accepted_qty', 'rejected_qty'])
        if (
          body[field] !== undefined &&
          Number(body[field]) !== Number(saved[field])
        )
          throw invalid(
            'An inspection result cannot be changed after processing',
          );
      await tx.commit();
      return { ...saved, already_applied: true };
    }
    if (!['pending', 'draft'].includes(inspection.status))
      throw invalid('Only pending inspections can be processed');
    const qty = quantities(
      inspection.inspected_qty,
      body.accepted_qty ?? inspection.accepted_qty,
      body.rejected_qty ?? inspection.rejected_qty,
    );
    const type = inspection.inspection_type,
      sourceId = inspection.reference_id || inspection.source_id;
    const source = await requireInspectionSource(
      db,
      type,
      sourceId,
      inspection.item_id,
      tx,
    );
    if (
      !Number.isFinite(Number(source.quantity)) ||
      qty.inspected > Number(source.quantity)
    )
      throw invalid('Inspection quantity exceeds source quantity');
    // Serialize incoming inspections against the same receipt before checking
    // cumulative inspected quantities and applying accepted-stock effects.
    if (type === 'incoming')
      await query('SELECT id FROM grn WHERE id=? FOR UPDATE', [sourceId]);
    const [[processed]] = await query(
      "SELECT COALESCE(SUM(inspected_qty),0) quantity FROM qc_inspections WHERE COALESCE(reference_id,source_id)=? AND item_id=? AND inspection_type=? AND status IN ('processed','closed') AND id<>? FOR UPDATE",
      [sourceId, inspection.item_id, type, id],
    );
    if (Number(processed.quantity) + qty.inspected > Number(source.quantity))
      throw invalid('Source quantity has already been inspected');
    if (type === 'incoming' && qty.accepted > 0) {
      if (!source.warehouse_id) throw invalid('Receipt warehouse is required');
      const [[legacy]] = await query(
        "SELECT COUNT(*) count FROM stock_ledger WHERE reference_type='grn' AND reference_id=? AND item_id=? AND qty_in>0",
        [sourceId, inspection.item_id],
      );
      // Legacy receipts already credited their entire quantity. They must not
      // receive another stock credit when their inspection is processed.
      if (!Number(legacy.count)) {
        await require('./zeroGapClosure.service').applyStockEffect(db, {
          operationKey: key,
          referenceType: 'qc_inspection',
          referenceId: id,
          itemId: inspection.item_id,
          warehouseId: source.warehouse_id,
          quantity: qty.accepted,
          rate: Number(source.rate || 0),
          direction: 'in',
          userId,
          transaction: tx,
        });
      }
    }
    const result = {
      id,
      status: 'processed',
      accepted_qty: qty.accepted,
      rejected_qty: qty.rejected,
    };
    await query(
      "UPDATE qc_inspections SET accepted_qty=?,rejected_qty=?,status='processed',overall_result=?,result=? WHERE id=?",
      [
        qty.accepted,
        qty.rejected,
        qty.rejected ? 'fail' : 'pass',
        qty.rejected ? 'fail' : 'pass',
        id,
      ],
    );
    if (qty.rejected > 0) {
      const [[setting]] = await query(
        "SELECT setting_value FROM company_settings WHERE setting_key='quality.auto_ncr_on_failure'",
      );
      if (
        ['true', '1'].includes(
          String(setting?.setting_value || '').toLowerCase(),
        )
      ) {
        const [[ncr]] = await query(
          "SELECT id FROM quality_ncrs WHERE inspection_id=? AND status<>'rejected' LIMIT 1 FOR UPDATE",
          [id],
        );
        if (!ncr) {
          const ncrId = uuid(),
            ncrNumber = `NCR-${String(id).slice(0, 8).toUpperCase()}`;
          await query(
            "INSERT INTO quality_ncrs(id,ncr_number,inspection_id,severity,description,status,owner_id) VALUES(?,?,?,?,?,'open',?)",
            [
              ncrId,
              ncrNumber,
              id,
              'major',
              'Automatically created from failed quality inspection',
              userId || null,
            ],
          );
          await query(
            'INSERT INTO quality_ncr_events(id,ncr_id,event_type,actor_id,event_note) VALUES(?,?,?,?,?)',
            [
              uuid(),
              ncrId,
              'created',
              userId || null,
              'Automatically created from failed inspection',
            ],
          );
          result.ncr_id = ncrId;
        } else result.ncr_id = ncr.id;
      }
    }
    await query(
      'INSERT INTO operation_keys(id,operation_key,result_json) VALUES(?,?,?)',
      [uuid(), key, JSON.stringify(result)],
    );
    await tx.commit();
    return result;
  } catch (cause) {
    await tx.rollback();
    throw cause;
  }
}
module.exports = { requireInspectionSource, quantities, processResult };
