const router = require('express').Router();
const { ok, asyncHandler } = require('../../utils/response');
const { auth } = require('../../middleware/auth');
const orgContext = require('../../middleware/orgContext');
const permission = require('../../middleware/permission');
const {
  getDemandForecast,
  getSmartReorderSuggestions,
  detectPriceAnomalies,
  getCashFlowForecast,
  getProductionEfficiency
} = require('../../services/forecasting.service');

router.use(auth, orgContext);

router.get('/demand', permission('reports', 'can_view'), asyncHandler(async (req, res) => {
  const result = await getDemandForecast(req.orgDb, req.query.item_id || null);
  return ok(res, result);
}));

router.get('/reorder-suggestions', permission('inventory', 'can_view'), asyncHandler(async (req, res) => {
  const result = await getSmartReorderSuggestions(req.orgDb);
  return ok(res, result);
}));

router.post('/check-po-rates', permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const anomalies = await detectPriceAnomalies(req.orgDb, req.body.items || null);
  return ok(res, anomalies);
}));

router.get('/cashflow', permission('finance', 'can_view'), asyncHandler(async (req, res) => {
  const result = await getCashFlowForecast(req.orgDb);
  return ok(res, result);
}));

router.get('/production-efficiency', permission('production', 'can_view'), asyncHandler(async (req, res) => {
  const result = await getProductionEfficiency(req.orgDb);
  return ok(res, result);
}));

module.exports = router;
