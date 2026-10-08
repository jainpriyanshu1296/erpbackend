const express = require('express');
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, created, asyncHandler } = require('../utils/response');
const { resources, aliases, resolve } = require('./fourModuleResources');
const service = require('../services/fourModuleCrud.service');
const router = express.Router();
const secure = (module, action) => [
  auth,
  orgContext,
  entitlement,
  moduleGuard(module),
  typeof action === 'function'
    ? (req, res, next) => permission(module, action(req))(req, res, next)
    : permission(module, action),
];
const resourceAccess = (action) => (req, res, next) => {
  let def;
  try {
    def = service.definition(req.query.endpoint);
  } catch (error) {
    return next(error);
  }
  return moduleGuard(def.module)(req, res, (error) =>
    error ? next(error) : permission(def.module, action)(req, res, next),
  );
};
router.get(
  '/operations/resources',
  auth,
  orgContext,
  entitlement,
  resourceAccess('can_view'),
  asyncHandler(async (req, res) => {
    const capabilities = service.capabilities(req.query.endpoint);
    let allowed = { can_create: 1, can_edit: 1, can_delete: 1 };
    if (!['admin', 'superadmin'].includes(req.user.role)) {
      const [[role]] = await req.orgDb.query(
        'SELECT can_create,can_edit,can_delete FROM role_permissions WHERE role=? AND module_key=? LIMIT 1',
        { replacements: [req.user.role, capabilities.module] },
      );
      allowed = role || { can_create: 0, can_edit: 0, can_delete: 0 };
    }
    return ok(res, {
      ...capabilities,
      permissions: {
        create: Boolean(allowed.can_create),
        edit: Boolean(allowed.can_edit),
        delete: Boolean(allowed.can_delete),
      },
    });
  }),
);
router.get(
  '/operations/record',
  auth,
  orgContext,
  entitlement,
  resourceAccess('can_view'),
  asyncHandler(async (req, res) =>
    ok(res, await service.detail(req, req.query.endpoint, req.query.id)),
  ),
);
// Canonical aliases retain the established stock-aware closure creators.
for (const [endpoint, target] of Object.entries({
  '/inventory/batches': '/closure/batches',
  '/inventory/serials': '/closure/serials',
  '/inventory/locations': '/closure/warehouse-locations',
  '/inventory/counts': '/closure/physical-counts',
  '/production/output': '/closure/production-outputs',
  '/production/scrap': '/closure/production-scrap',
  '/production/downtime': '/closure/production-downtime',
}))
  for (const method of ['get', 'post'])
    router[method](endpoint, (req, res, next) => {
      const previous = req.url;
      req.url =
        target +
        (previous.includes('?') ? previous.slice(previous.indexOf('?')) : '');
      require('./zeroGapClosure.routes').handle(req, res, (error) => {
        req.url = previous;
        next(error);
      });
    });
const missingDetail = new Set([
  '/purchase/returns',
  '/inventory/adjustments',
  '/inventory/batches',
  '/inventory/serials',
  '/inventory/locations',
  '/inventory/counts',
  '/production/output',
  '/production/scrap',
  '/production/downtime',
  '/closure/rfq/suppliers',
  '/closure/rfq/quotation-lines',
  '/closure/physical-counts/lines',
  '/closure/batches',
  '/closure/serials',
  '/closure/warehouse-locations',
  '/closure/physical-counts',
  '/closure/production-outputs',
  '/closure/production-scrap',
  '/closure/production-downtime',
]);
for (const endpoint of [...Object.keys(resources), ...Object.keys(aliases)]) {
  const def = resolve(endpoint);
  if (def.category) continue;
  if (def.settings) {
    router.get(
      `${endpoint}/:id`,
      ...secure(def.module, 'can_view'),
      asyncHandler(async (req, res) =>
        ok(res, await service.detail(req, endpoint, req.params.id)),
      ),
    );
    for (const method of ['post', 'put', 'patch'])
      router[method](
        endpoint,
        ...secure(def.module, 'can_edit'),
        asyncHandler(async (req, res) => {
          const { setting_key, ...data } = req.body;
          return ok(
            res,
            await service.saveSetting(req, endpoint, setting_key, data),
          );
        }),
      );
  }
  if (missingDetail.has(endpoint))
    router.get(
      `${endpoint}/:id`,
      ...secure(def.module, 'can_view'),
      asyncHandler(async (req, res, next) => {
        if (def.table === 'physical_counts' && req.params.id === 'lines')
          return next();
        return ok(res, await service.detail(req, endpoint, req.params.id));
      }),
    );
  // Keep existing validated creators and workflow action routes in control.
  if (endpoint === '/production/job-cards')
    router.post(
      endpoint,
      ...secure(def.module, 'can_create'),
      asyncHandler(async (req, res) =>
        created(res, await service.create(req, endpoint, req.body)),
      ),
    );
  for (const method of ['put', 'patch'])
    router[method](
      `${endpoint}/:id`,
      ...secure(def.module, 'can_edit'),
      asyncHandler(async (req, res) =>
        ok(res, await service.update(req, endpoint, req.params.id, req.body)),
      ),
    );
  router.delete(
    `${endpoint}/:id`,
    ...secure(def.module, 'can_delete'),
    asyncHandler(async (req, res) =>
      ok(res, await service.remove(req, endpoint, req.params.id)),
    ),
  );
  if (def.children) {
    for (const method of ['put', 'patch'])
      router[method](
        `${endpoint}/:id/items`,
        ...secure(def.module, 'can_edit'),
        asyncHandler(async (req, res) =>
          ok(
            res,
            await service.update(req, endpoint, req.params.id, {
              items: Array.isArray(req.body) ? req.body : req.body.items,
            }),
          ),
        ),
      );

    router.get(
      `${endpoint}/:id/items`,
      ...secure(def.module, 'can_view'),
      asyncHandler(async (req, res) =>
        ok(res, (await service.detail(req, endpoint, req.params.id)).items),
      ),
    );
    router.get(
      `${endpoint}/:id/items/:lineId`,
      ...secure(def.module, 'can_view'),
      asyncHandler(async (req, res) => {
        const record = await service.detail(req, endpoint, req.params.id);
        const item = record.items.find((line) => line.id === req.params.lineId);
        if (!item) throw service.fail('Line item not found', 404);
        return ok(res, item);
      }),
    );
    for (const method of ['post', 'put', 'patch', 'delete']) {
      router[method](
        `${endpoint}/:id/items${method === 'post' ? '' : '/:lineId'}`,
        ...secure(
          def.module,
          method === 'post'
            ? (req) =>
                Array.isArray(req.body.items) ? 'can_edit' : 'can_create'
            : method === 'delete'
              ? 'can_delete'
              : 'can_edit',
        ),
        asyncHandler(async (req, res) => {
          if (method === 'post' && Array.isArray(req.body.items))
            return ok(
              res,
              await service.update(req, endpoint, req.params.id, {
                items: req.body.items,
              }),
            );
          const result = await service.mutateLine(
            req,
            endpoint,
            req.params.id,
            req.params.lineId,
            req.method,
            req.body,
          );
          return method === 'post' ? created(res, result) : ok(res, result);
        }),
      );
    }
  }
}
// Existing BOM builder sends a complete component collection.
router.get(
  '/production/bom/:id/components',
  ...secure('production', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      (await service.detail(req, '/production/bom', req.params.id)).items,
    ),
  ),
);
for (const method of ['post', 'put', 'patch'])
  router[method](
    '/production/bom/:id/components',
    ...secure('production', 'can_edit'),
    asyncHandler(async (req, res) =>
      ok(
        res,
        await service.update(req, '/production/bom', req.params.id, {
          components: req.body.components,
        }),
      ),
    ),
  );
for (const method of ['get', 'put', 'patch', 'delete'])
  router[method](
    '/production/bom/:id/components/:lineId',
    ...secure(
      'production',
      method === 'get'
        ? 'can_view'
        : method === 'delete'
          ? 'can_delete'
          : 'can_edit',
    ),
    asyncHandler(async (req, res) => {
      if (method === 'get') {
        const item = (
          await service.detail(req, '/production/bom', req.params.id)
        ).items.find((line) => line.id === req.params.lineId);
        if (!item) throw service.fail('Component not found', 404);
        return ok(res, item);
      }
      return ok(
        res,
        await service.mutateLine(
          req,
          '/production/bom',
          req.params.id,
          req.params.lineId,
          req.method,
          req.body,
        ),
      );
    }),
  );
const routing = require('../services/productionRoutingCrud.service');
router.get(
  '/production/work-orders/:id/operations/:opId',
  ...secure('production', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[row]] = await req.orgDb.query(
      'SELECT r.* FROM wo_routing_operations r JOIN work_orders w ON w.id=r.wo_id WHERE r.id=? AND w.id=?',
      { replacements: [req.params.opId, req.params.id] },
    );
    if (!row) throw service.fail('Operation not found', 404);
    return ok(res, row);
  }),
);
for (const method of ['post', 'put', 'patch', 'delete'])
  router[method](
    `/production/work-orders/:id/operations${method === 'post' ? '' : '/:opId'}`,
    ...secure(
      'production',
      method === 'post'
        ? 'can_create'
        : method === 'delete'
          ? 'can_delete'
          : 'can_edit',
    ),
    asyncHandler(async (req, res) => {
      const result = await routing.mutate(
        req,
        req.params.id,
        req.params.opId,
        req.method,
        req.body,
      );
      return req.method === 'POST' ? created(res, result) : ok(res, result);
    }),
  );
module.exports = router;
