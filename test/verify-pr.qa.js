// Manual, write-producing verification. Pass a dedicated qa-codex tenant slug.
// This is deliberately outside the automatic test glob.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const master = require('../src/config/db');
const { getOrgDb, closeOrgDbs } = require('../src/config/orgDb');

let server;
let step = 'tenant mapping';

async function main() {
  const slug = process.argv[2];
  if (!/^qa-codex-[a-f0-9]{8}$/.test(slug || '')) {
    throw new Error('A dedicated qa-codex tenant slug is required');
  }
  const [[org]] = await master.query(
    'SELECT id,slug,db_name,status,is_active FROM organizations WHERE slug=?',
    { replacements: [slug] },
  );
  if (
    !org ||
    org.db_name !== `org_qa_codex_${slug.slice('qa-codex-'.length)}` ||
    org.status !== 'active' ||
    !org.is_active
  ) {
    throw new Error('Dedicated QA tenant mapping is unavailable');
  }

  const db = getOrgDb(org.db_name);
  const email = 'qa-codex@invalid.example';
  const password = crypto.randomBytes(24).toString('hex');
  const passwordHash = await bcrypt.hash(password, 10);
  const [[existing]] = await db.query('SELECT id FROM users WHERE email=?', {
    replacements: [email],
  });
  if (existing) {
    await db.query(
      'UPDATE users SET password_hash=?,role=?,is_active=1 WHERE id=?',
      { replacements: [passwordHash, 'admin', existing.id] },
    );
  } else {
    await db.query(
      'INSERT INTO users(id,name,email,password_hash,role,is_active) VALUES(?,?,?,?,?,1)',
      { replacements: [uuid(), 'QA verifier', email, passwordHash, 'admin'] },
    );
  }

  const origin = `http://${slug}.daanoday.com`;
  process.env.FRONTEND_URL = origin;
  process.env.JWT_SECRET ||= crypto.randomBytes(32).toString('hex');
  const app = require('../src/app');
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  let cookie = '';

  async function call(method, path, body) {
    step = `${method} ${path}`;
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(`${response.status}:${result.error || 'ERROR'}`);
    }
    return { response, result };
  }

  const login = await call('POST', '/auth/login', { email, password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('erp_access='))
    .split(';')[0];
  if (login.result.data?.org?.id !== org.id) {
    throw new Error('Login tenant mismatch');
  }
  const me = await call('GET', '/auth/me');
  if (me.result.data?.orgId !== org.id) {
    throw new Error('Session tenant mismatch');
  }

  const suffix = crypto.randomBytes(3).toString('hex');
  const uom = (
    await call('POST', '/inventory/uom', {
      uom_code: `QA${suffix}`,
      uom_name: `QA unit ${suffix}`,
    })
  ).result.data;
  const item = (
    await call('POST', '/inventory/items', {
      item_code: `QA-ITEM-${suffix}`,
      item_name: `QA item ${suffix}`,
      item_type: 'raw_material',
      uom_id: uom.id,
    })
  ).result.data;
  const warehouse = (
    await call('POST', '/inventory/warehouses', {
      warehouse_code: `QA-WH-${suffix}`,
      warehouse_name: `QA warehouse ${suffix}`,
    })
  ).result.data;
  const pr = (
    await call('POST', '/purchase/requisitions', {
      department: 'QA',
      priority: 'normal',
      items: [{ item_id: item.id, quantity: 2 }],
    })
  ).result.data;
  if (!pr.id || !pr.pr_number) throw new Error('PR ID or number missing');

  step = 'tenant DB persistence';
  const [[persisted]] = await db.query(
    'SELECT id,pr_number,status FROM purchase_requisitions WHERE id=?',
    { replacements: [pr.id] },
  );
  if (persisted?.pr_number !== pr.pr_number || persisted.status !== 'draft') {
    throw new Error('PR not persisted as draft');
  }

  const variants = {
    default: '',
    draft: '?status=draft',
    search: `?search=${encodeURIComponent(pr.pr_number)}`,
    sort: '?sort=pr_number&direction=asc',
    pagination: '?page=1&limit=1&sort=created_at&direction=desc',
  };
  const lists = {};
  for (const [name, query] of Object.entries(variants)) {
    const { result } = await call('GET', `/purchase/requisitions${query}`);
    lists[name] = result.data?.some((row) => row.id === pr.id) || false;
    if (!lists[name]) throw new Error(`PR missing in ${name} list`);
  }
  const detail = (await call('GET', `/purchase/requisitions/${pr.id}`)).result
    .data;
  if (detail.id !== pr.id || detail.items?.length !== 1) {
    throw new Error('PR detail mismatch');
  }
  const submitted = (
    await call('POST', `/purchase/requisitions/${pr.id}/submit`, {})
  ).result.data;
  const submittedList = (
    await call(
      'GET',
      `/purchase/requisitions?status=submitted&search=${encodeURIComponent(pr.pr_number)}`,
    )
  ).result.data;
  if (!submittedList?.some((row) => row.id === pr.id)) {
    throw new Error('Submitted PR missing from filtered list');
  }

  console.log(
    JSON.stringify({
      tenant: slug,
      loginTenant: true,
      sessionTenant: true,
      itemId: item.id,
      uomId: uom.id,
      warehouseId: warehouse.id,
      prId: pr.id,
      prNumber: pr.pr_number,
      dbPersisted: true,
      lists,
      detail: true,
      submitStatus: submitted?.status,
      submittedList: true,
    }),
  );
}

main()
  .catch((cause) => {
    console.error(
      `FAILED ${step} ${cause.code || cause.message || cause.name}`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await closeOrgDbs();
    await master.close();
  });
