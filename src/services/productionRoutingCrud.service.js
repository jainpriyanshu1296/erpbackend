const { v4: uuid } = require('uuid');
const { clean, fail } = require('./fourModuleCrud.service');
const { audit } = require('../modules/inventoryPurchase.service');
const editableFields = [
  'stage_name',
  'sequence_no',
  'machine_id',
  'operator_id',
  'description',
  'notes',
];
async function mutate(req, workOrderId, operationId, method, body = {}) {
  return req.orgDb.transaction(async (transaction) => {
    const query = (sql, replacements = []) =>
      req.orgDb.query(sql, { replacements, transaction });
    const [[work]] = await query(
      'SELECT id,status,planned_qty FROM work_orders WHERE id=? FOR UPDATE',
      [workOrderId],
    );
    if (!work) throw fail('Work order not found', 404);
    if (!['draft', 'released', 'in_progress'].includes(work.status))
      throw fail('Closed work orders cannot change routing', 409);
    let operation;
    if (method !== 'POST') {
      const [[row]] = await query(
        'SELECT * FROM wo_routing_operations WHERE id=? AND wo_id=? FOR UPDATE',
        [operationId, workOrderId],
      );
      if (!row) throw fail('Operation not found', 404);
      operation = row;
    }
    if (method === 'DELETE') {
      if (operation.status !== 'pending')
        throw fail('Only pending operations can be deleted', 409);
      const [[card]] = await query(
        'SELECT id FROM job_cards WHERE operation_id=? LIMIT 1 FOR UPDATE',
        [operationId],
      );
      if (card) throw fail('Operation has a job card', 409);
      await query('DELETE FROM wo_routing_operations WHERE id=? AND wo_id=?', [
        operationId,
        workOrderId,
      ]);
    } else {
      const data = clean(
        [...editableFields, 'status', 'completed_qty', 'rejected_qty'],
        body,
        ['stage_name'],
        method === 'POST',
      );
      for (const key of ['sequence_no', 'completed_qty', 'rejected_qty'])
        if (data[key] !== undefined) {
          const value = Number(data[key]);
          if (
            !Number.isFinite(value) ||
            value < 0 ||
            (key === 'sequence_no' &&
              (!Number.isSafeInteger(value) || value < 1))
          )
            throw fail(`Invalid ${key}`);
          data[key] = value;
        }
      if (
        work.status === 'draft' &&
        (['in_progress', 'completed'].includes(data.status) ||
          Number(data.completed_qty || 0) ||
          Number(data.rejected_qty || 0))
      )
        throw fail('Release the work order before recording actuals', 409);
      if (method === 'POST') {
        if (data.status && data.status !== 'pending')
          throw fail('New operations must be pending');
        if (Number(data.completed_qty || 0) || Number(data.rejected_qty || 0))
          throw fail('New operations cannot contain actual quantities');
        operationId = uuid();
        data.status = 'pending';
        data.sequence_no = data.sequence_no || 1;
        const keys = Object.keys(data);
        await query(
          `INSERT INTO wo_routing_operations(id,wo_id,${keys.join(',')}) VALUES(?,?,${keys.map(() => '?').join(',')})`,
          [operationId, workOrderId, ...Object.values(data)],
        );
      } else {
        if (!Object.keys(data).length)
          throw fail('No editable fields supplied');
        if (
          operation.status !== 'pending' &&
          Object.keys(data).some(
            (key) => editableFields.includes(key) && key !== 'notes',
          )
        )
          throw fail('Only pending operation plans can be edited', 409);
        const transitions = {
          pending: ['in_progress', 'cancelled'],
          in_progress: ['completed', 'cancelled'],
          completed: [],
          cancelled: [],
        };
        if (
          data.status &&
          data.status !== operation.status &&
          !(transitions[operation.status] || []).includes(data.status)
        )
          throw fail('Invalid operation status transition', 409);
        if (
          ['completed', 'cancelled'].includes(operation.status) &&
          Object.keys(data).some((key) => key !== 'notes')
        )
          throw fail('Closed operation actuals cannot change', 409);
        if (
          Number(data.completed_qty ?? operation.completed_qty ?? 0) +
            Number(data.rejected_qty ?? operation.rejected_qty ?? 0) >
          Number(work.planned_qty)
        )
          throw fail('Operation actual quantity exceeds the work order');
        const keys = Object.keys(data);
        const timestamps =
          data.status === 'in_progress'
            ? ',actual_start=COALESCE(actual_start,NOW())'
            : data.status === 'completed'
              ? ',actual_end=NOW()'
              : '';
        await query(
          `UPDATE wo_routing_operations SET ${keys.map((key) => `${key}=?`).join(',')}${timestamps} WHERE id=? AND wo_id=?`,
          [...Object.values(data), operationId, workOrderId],
        );
      }
    }
    await audit(
      req.orgDb,
      req.user.sub,
      'production',
      `routing.${method.toLowerCase()}`,
      'wo_routing_operations',
      operationId,
      { work_order_id: workOrderId },
      transaction,
    );
    return {
      id: operationId,
      wo_id: workOrderId,
      ...(method === 'DELETE' ? { deleted: true } : {}),
    };
  });
}
module.exports = { mutate };
