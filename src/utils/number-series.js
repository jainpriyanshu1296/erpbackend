async function getNextNumber(db, type) {
  const tx = await db.transaction();
  try {
    const [rows] = await db.query(
      'SELECT prefix,next_number,padding FROM number_series WHERE series_key=? FOR UPDATE',
      { replacements: [type], transaction: tx },
    );
    const current = Number(rows[0]?.next_number || 1),
      prefix = rows[0]?.prefix || `${type.toUpperCase()}-`,
      padding = Number(rows[0]?.padding || 5);
    if (rows.length)
      await db.query(
        'UPDATE number_series SET next_number=next_number+1 WHERE series_key=?',
        { replacements: [type], transaction: tx },
      );
    else
      await db.query(
        'INSERT INTO number_series(series_key,prefix,next_number,padding) VALUES(?,?,2,?)',
        { replacements: [type, prefix, padding], transaction: tx },
      );
    await tx.commit();
    return `${prefix}${new Date().getFullYear()}-${String(current).padStart(padding, '0')}`;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}
module.exports = { getNextNumber };
