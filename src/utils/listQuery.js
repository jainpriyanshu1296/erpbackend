function listQuery(query, allowedSort, fallback = allowedSort[0]) {
  const page = Number(query.page || 1), limit = Number(query.limit || 20);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('page must be positive and limit must be between 1 and 100'), { status: 400, code: 'VALIDATION_ERROR' });
  const sort = allowedSort.includes(query.sort) ? query.sort : fallback;
  return { page, limit, offset: (page - 1) * limit, search: typeof query.search === 'string' ? query.search.trim() : '', sort, direction: query.direction === 'desc' ? 'DESC' : 'ASC' };
}
module.exports = listQuery;
