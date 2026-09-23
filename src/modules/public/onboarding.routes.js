const router = require('express').Router();
const { asyncHandler, created, ok } = require('../../utils/response');
const {
  createPendingOrganization,
  createPendingOrder,
  verifyPendingPayment,
} = require('../../services/onboarding.service');

router.post(
  '/organizations',
  asyncHandler(async (req, res) => {
    const required = [
      'company_name',
      'owner_email',
      'password',
      'subdomain',
      'plan',
      'duration_months',
    ];
    const missing = required.filter((key) => !req.body[key]);
    if (missing.length)
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Required onboarding fields are missing',
        details: missing,
      });
    return created(
      res,
      await createPendingOrganization(req.body),
      'Organization created and awaiting payment',
    );
  }),
);

router.post(
  '/organizations/:id/order',
  asyncHandler(async (req, res) => {
    return ok(
      res,
      await createPendingOrder({
        organizationId: req.params.id,
        subscriptionId: req.body.subscription_id,
      }),
    );
  }),
);

router.post(
  '/payments/verify',
  asyncHandler(async (req, res) => {
    return ok(res, await verifyPendingPayment(req.body), 'Payment verified');
  }),
);

module.exports = router;
