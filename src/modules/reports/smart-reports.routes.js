const router = require('express').Router();
const { ok, asyncHandler } = require('../../utils/response');
const { auth } = require('../../middleware/auth');
const orgContext = require('../../middleware/orgContext');
const permission = require('../../middleware/permission');
const {
  getAvailableQueries,
  executeSmartQuery,
} = require('../../services/smart-reports.service');

router.use(auth, orgContext);

router.get(
  '/smart-queries',
  permission('reports', 'can_view'),
  asyncHandler(async (req, res) => {
    return ok(res, getAvailableQueries());
  }),
);

router.post(
  '/execute-smart-query',
  permission('reports', 'can_view'),
  asyncHandler(async (req, res) => {
    const { query_id, params } = req.body;
    if (!query_id) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'query_id is required',
      });
    }
    const result = await executeSmartQuery(req.orgDb, query_id, params || {});
    return ok(res, result);
  }),
);

module.exports = router;
