function ok(res, data, message = 'Success', meta) { return res.status(200).json({ success: true, data, message, ...(meta ? { meta } : {}) }); }
function created(res, data, message = 'Created successfully') { return res.status(201).json({ success: true, data, message }); }
function fail(res, status, error, message, details) { return res.status(status).json({ success: false, error, message, ...(details ? { details } : {}) }); }
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { ok, created, fail, asyncHandler };
