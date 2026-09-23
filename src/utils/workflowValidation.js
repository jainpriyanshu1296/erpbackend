function aggregateItemQuantities(items, field) {
  if (!Array.isArray(items) || !items.length)
    throw Object.assign(new Error('At least one item is required'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  const totals = new Map();
  for (const item of items) {
    const quantity = Number(item?.[field]);
    if (!item?.item_id || !Number.isFinite(quantity) || quantity <= 0)
      throw Object.assign(
        new Error(`Each item must have item_id and positive ${field}`),
        { status: 400, code: 'VALIDATION_ERROR' },
      );
    totals.set(item.item_id, (totals.get(item.item_id) || 0) + quantity);
  }
  return totals;
}
module.exports = { aggregateItemQuantities };
