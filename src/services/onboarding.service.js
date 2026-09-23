const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const masterDb = require('../config/db');
const { getOrgDb } = require('../config/orgDb');
const { createOrder, fetchPayment, verifyPayment, verifyWebhook } = require('./razorpay.service');
const { slugify } = require('../utils/helpers');
const { hostnameForSubdomain } = require('../config/domain');
const { applyMigrationsToDb } = require('../migrations/run');

const VALID_PLANS = ['free', 'starter', 'growth', 'pro'];
const isPaymentAlreadyProcessed = order => ['paid', 'activated'].includes(String(order?.status || '').toLowerCase());
const provisioningFailureState = error => ({
  status: 'retry_pending',
  last_error: String(error?.message || error || 'Provisioning failed'),
  retryable: true
});

async function provisionOrganization(input) {
  require('../utils/provisioningValidation').validateIdentity(input);
  if (!VALID_PLANS.includes(input.plan)) throw Object.assign(new Error('Choose a valid plan'), {status:400,code:'INVALID_PLAN_SELECTION',details:{plan:'Choose a valid plan'}});
  const duration = Number(input.duration_months ?? input.durationMonths);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 120) throw Object.assign(new Error('Choose a valid billing duration'), {status:400,code:'INVALID_PLAN_SELECTION',details:{duration_months:'Choose a valid billing duration'}});
  const slug = slugify(input.slug || input.subdomain || input.company_name);
  const id = input.organizationId || uuid();
  const dbName = `org_${slug.replace(/-/g, '_')}`;
  const passwordHash = input.passwordHash || await bcrypt.hash(input.password, 12);
  const transaction = await masterDb.transaction();
  try {
    const [existing] = await masterDb.query('SELECT id,status,db_name FROM organizations WHERE slug=? OR db_name=? LIMIT 1', {
      replacements: [slug, dbName], transaction
    });
    if (input.retryExisting) {
      if(existing.length!==1 || existing[0].id!==id || !['pending','provisioning'].includes(existing[0].status) || existing[0].db_name!==dbName) throw Object.assign(new Error('Organization is not eligible for provisioning retry'),{status:409,code:'PROVISIONING_RETRY_INVALID'});
      await masterDb.query("UPDATE organizations SET status='provisioning' WHERE id=?",{replacements:[id],transaction});
      await masterDb.query("UPDATE provisioning_jobs SET status='provisioning',attempts=attempts+1,started_at=NOW(),last_error=NULL WHERE organization_id=?",{replacements:[id],transaction});
    } else {
    if (existing.length) throw Object.assign(new Error('Organization slug already exists'), { status: 409, code: 'CONFLICT',details:{slug:'This organization slug is already in use'} });
    await masterDb.query(
      `INSERT INTO organizations
       (id,slug,db_name,company_name,owner_name,owner_email,owner_phone,gstin,state,plan,status,is_active,is_trial)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,1,0)`,
      { replacements: [id, slug, dbName, input.company_name, input.owner_name || input.company_name, input.owner_email, input.owner_phone || '', input.gstin || null, input.state || null, input.plan, 'provisioning'], transaction }
    );
    await masterDb.query('INSERT INTO organization_domains(id,organization_id,hostname,subdomain,is_primary,is_active) VALUES(?,?,?,?,1,1)', {
      replacements: [uuid(), id, hostnameForSubdomain(slug), slug], transaction
    });
    await masterDb.query('INSERT INTO provisioning_jobs(id,organization_id,status) VALUES(?,?,?)', {
      replacements: [uuid(), id, 'provisioning'], transaction
    });
    await masterDb.query('INSERT INTO pending_organization_accounts(id,organization_id,owner_password_hash) VALUES(?,?,?)',{replacements:[uuid(),id,passwordHash],transaction});
    await masterDb.query('UPDATE provisioning_jobs SET duration_months=? WHERE organization_id=?',{replacements:[duration,id],transaction});
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  let root;
  try {
    root = await mysql.createConnection({
      host: process.env.MASTER_DB_HOST || 'localhost',
      port: Number(process.env.MASTER_DB_PORT || 3306),
      user: process.env.MASTER_DB_USER || 'root',
      password: process.env.MASTER_DB_PASS || '',
      multipleStatements: true
    });
    const [databases] = await root.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',[dbName]);
    if (databases.length && !input.retryExisting) throw Object.assign(new Error('Database name is already allocated; provisioning cannot reuse it'),{status:409,code:'DATABASE_ALREADY_EXISTS'});
    if(!databases.length) await root.query(`CREATE DATABASE \`${dbName.replace(/`/g, '')}\``);
    await root.changeUser({ database: dbName });
    await applyMigrationsToDb(root, dbName, 'org');
    const [admins] = await root.query('SELECT id,role,is_active FROM users WHERE email=? LIMIT 1', [input.owner_email]);
    if (admins.length && !['admin','superadmin'].includes(String(admins[0].role || '').toLowerCase())) throw Object.assign(new Error('The owner email already belongs to a non-administrator account'),{status:409,code:'PROVISIONING_ADMIN_CONFLICT'});
    const adminId = admins[0]?.id || uuid();
    if (!admins.length) await root.query('INSERT INTO users (id,name,email,password_hash,role,is_active) VALUES (?,?,?,?,?,1)', [
      adminId, input.owner_name || input.company_name, input.owner_email, passwordHash, 'admin'
    ]);
    else if (!admins[0].is_active) await root.query('UPDATE users SET is_active=1 WHERE id=?',[adminId]);
    await root.end();
    await masterDb.transaction(async transaction => {
      await masterDb.query('UPDATE organizations SET status="active",is_active=1,is_trial=?,plan_started_at=NOW(),plan_expires_at=DATE_ADD(NOW(),INTERVAL ? MONTH) WHERE id=?', { replacements: [input.plan === 'free' ? 1 : 0,duration,id],transaction });
      await masterDb.query('UPDATE provisioning_jobs SET status="provisioned",completed_at=NOW(),last_error=NULL WHERE organization_id=?', { replacements: [id],transaction });
      await masterDb.query('DELETE FROM pending_organization_accounts WHERE organization_id=?',{replacements:[id],transaction});
    });
    const [orgRows] = await masterDb.query('SELECT id,slug,db_name,company_name,plan FROM organizations WHERE id=?', { replacements: [id] });
    return {
      org: orgRows[0],
      user: { id: adminId, name: input.owner_name || input.company_name, email: input.owner_email, role: 'admin' },
      orgDb: getOrgDb(dbName)
    };
  } catch (error) {
    await root?.end().catch(() => {});
    const state = provisioningFailureState(error);
    await masterDb.query('UPDATE organizations SET status="pending",is_active=0 WHERE id=?', { replacements: [id] }).catch(() => {});
    await masterDb.query(
      'UPDATE provisioning_jobs SET status=?,last_error=?,next_attempt_at=DATE_ADD(NOW(),INTERVAL 5 MINUTE) WHERE organization_id=?',
      { replacements: [state.status, state.last_error, id] }
    ).catch(() => {});
    throw error;
  }
}

async function retryProvisionOrganization(organizationId) {
  const [[org]]=await masterDb.query("SELECT o.*,j.duration_months,a.owner_password_hash FROM organizations o JOIN provisioning_jobs j ON j.organization_id=o.id JOIN pending_organization_accounts a ON a.organization_id=o.id WHERE o.id=? AND o.status='pending' AND j.status='retry_pending'",{replacements:[organizationId]});
  if(!org) throw Object.assign(new Error('No retryable provisioning job was found'),{status:409,code:'PROVISIONING_RETRY_INVALID'});
  return provisionOrganization({organizationId:org.id,retryExisting:true,company_name:org.company_name,owner_name:org.owner_name,owner_email:org.owner_email,owner_phone:org.owner_phone,slug:org.slug,plan:org.plan,duration_months:Number(org.duration_months),passwordHash:org.owner_password_hash});
}

async function validateSelection({ subdomain, plan, plan_code, plan_id, duration_months, durationMonths: legacyDuration, billing_period, modules = [] }) {
  const invalidPlan = (message,field='plan') => Object.assign(new Error(message),{status:400,code:'INVALID_PLAN_SELECTION',details:{[field]:message}});
  if (plan && plan_code && plan !== plan_code) throw invalidPlan('Conflicting plan codes');
  plan = plan || plan_code;
  if (plan_id !== undefined) {
    if (!Number.isSafeInteger(Number(plan_id)) || Number(plan_id)<1) throw invalidPlan('Invalid plan price ID','plan_id');
    const [[offer]] = await masterDb.query('SELECT plan,duration_months FROM plan_pricing WHERE id=? AND is_active=1',{replacements:[Number(plan_id)]});
    if (!offer) throw invalidPlan('Plan price is unavailable','plan_id');
    if (plan && plan !== offer.plan) throw invalidPlan('Plan code does not match selected price');
    if ((duration_months !== undefined && Number(duration_months)!==Number(offer.duration_months)) || (legacyDuration !== undefined && Number(legacyDuration)!==Number(offer.duration_months))) throw invalidPlan('Billing duration does not match selected price','duration_months');
    plan = offer.plan; duration_months = offer.duration_months;
  }
  if (billing_period !== undefined) {
    const months = {monthly:1,annual:12,yearly:12}[billing_period];
    if (!months || (duration_months !== undefined && Number(duration_months)!==months) || (legacyDuration !== undefined && Number(legacyDuration)!==months)) throw invalidPlan('Billing period and duration disagree','duration_months');
    duration_months = months;
  }
  // Normalize the API contract once; existing internal callers use durationMonths.
  if (duration_months !== undefined && legacyDuration !== undefined && Number(duration_months) !== Number(legacyDuration)) {
    throw invalidPlan('Conflicting billing durations','duration_months');
  }
  const durationMonths = Number(duration_months ?? legacyDuration);
  if (!VALID_PLANS.includes(plan) || !Number.isSafeInteger(durationMonths) || durationMonths < 1 || durationMonths > 120) {
    throw invalidPlan('Invalid plan or billing cycle',VALID_PLANS.includes(plan)?'duration_months':'plan');
  }
  if (!Array.isArray(modules)) throw Object.assign(new Error('modules must be an array'), { status: 400, code: 'INVALID_MODULE_SELECTION' });
  const normalized = slugify(subdomain);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(normalized)) {
    throw Object.assign(new Error('Subdomain must contain 1-63 lowercase letters, numbers or hyphens'), { status: 400, code: 'INVALID_SUBDOMAIN' });
  }
  const [reserved] = await masterDb.query('SELECT subdomain FROM reserved_subdomains WHERE subdomain=?', { replacements: [normalized] });
  if (reserved.length) throw Object.assign(new Error('This subdomain is reserved'), { status: 409, code: 'RESERVED_SUBDOMAIN',details:{subdomain:'This subdomain is reserved',slug:'This slug is reserved'} });
  const [domains] = await masterDb.query('SELECT id FROM organization_domains WHERE subdomain=? OR hostname=?', { replacements: [normalized, hostnameForSubdomain(normalized)] });
  if (domains.length) throw Object.assign(new Error('This subdomain is already in use'), { status: 409, code: 'SUBDOMAIN_ALREADY_EXISTS',details:{subdomain:'This subdomain is already in use',slug:'This slug is already in use'} });
  const selected = [...new Set(modules.map(String))];
  if (selected.length) {
    const [rows] = await masterDb.query(
      'SELECT module_key FROM modules m INNER JOIN module_catalog c ON c.module_key=m.module_key WHERE m.module_key IN (?) AND c.is_active=1 AND c.is_purchasable=1',
      { replacements: [selected] }
    );
    const allowed = new Set(rows.map(row => row.module_key));
    const invalid = selected.filter(key => !allowed.has(key));
    if (invalid.length) throw Object.assign(new Error('One or more selected modules are unavailable'), { status: 400, code: 'INVALID_MODULE_SELECTION', details: invalid });
  }
  const pricing = plan==='free' ? [{amount:0}] : (await masterDb.query('SELECT amount FROM plan_pricing WHERE plan=? AND duration_months=? AND is_active=1 LIMIT 1', { replacements: [plan, durationMonths] }))[0];
  if (!pricing.length) throw Object.assign(new Error('Selected plan pricing is unavailable'), { status: 400, code: 'PRICING_UNAVAILABLE',details:{plan:'Choose an available plan',duration_months:'Choose an available billing duration'} });
  let moduleAmount = 0;
  if (selected.length) {
    const [modulePricing] = await masterDb.query('SELECT module_key,amount FROM module_pricing WHERE module_key IN (?) AND duration_months=? AND is_active=1', { replacements: [selected, durationMonths] });
    const priceMap = new Map(modulePricing.map(row => [row.module_key, Number(row.amount)]));
    const unpriced = selected.filter(key => !priceMap.has(key));
    if (unpriced.length) throw Object.assign(new Error('Pricing is unavailable for one or more selected modules'), { status: 400, code: 'MODULE_PRICING_UNAVAILABLE', details: unpriced });
    moduleAmount = modulePricing.reduce((total, row) => total + Number(row.amount), 0);
  }
  return { subdomain: normalized, durationMonths: Number(durationMonths), modules: selected, plan, planAmount: Number(pricing[0].amount), totalAmount: Number(pricing[0].amount) + moduleAmount };
}

async function createPendingOrganization(input) {
  require('../utils/provisioningValidation').validateIdentity(input);
  const selection = await validateSelection(input);
  const organizationId = uuid();
  const subscriptionId = uuid();
  const accountId = uuid();
  const dbName = `org_${selection.subdomain.replace(/-/g, '_')}`;
  const passwordHash = await bcrypt.hash(input.password, 12);
  await masterDb.transaction(async transaction => {
    await masterDb.query(
      `INSERT INTO organizations
       (id,slug,db_name,company_name,owner_name,owner_email,owner_phone,gstin,address,city,state,plan,status,is_active,is_trial)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,0)`,
      { replacements: [organizationId, selection.subdomain, dbName, input.company_name, input.owner_name || input.company_name, input.owner_email, input.owner_phone || '', input.gstin || null, input.address || null, input.city || null, input.state || null, selection.plan, 'pending_payment'], transaction }
    );
    await masterDb.query('INSERT INTO organization_domains(id,organization_id,hostname,subdomain,is_primary,is_active) VALUES(?,?,?,?,1,1)', {
      replacements: [uuid(), organizationId, hostnameForSubdomain(selection.subdomain), selection.subdomain], transaction
    });
    await masterDb.query('INSERT INTO pending_organization_accounts(id,organization_id,owner_password_hash) VALUES(?,?,?)', {
      replacements: [accountId, organizationId, passwordHash], transaction
    });
    await masterDb.query('INSERT INTO subscriptions(id,org_id,plan,duration_months,amount,currency,status) VALUES(?,?,?,?,?,?,?)', {
      replacements: [subscriptionId, organizationId, selection.plan, selection.durationMonths, selection.totalAmount, 'INR', 'pending'], transaction
    });
    await masterDb.query('INSERT INTO provisioning_jobs(id,organization_id,status) VALUES(?,?,?)', {
      replacements: [uuid(), organizationId, 'pending'], transaction
    });
    for (const moduleKey of selection.modules) {
      const [modulePrice] = await masterDb.query('SELECT amount FROM module_pricing WHERE module_key=? AND duration_months=? AND is_active=1 LIMIT 1', { replacements: [moduleKey, selection.durationMonths], transaction });
      await masterDb.query('INSERT INTO subscription_items(id,subscription_id,module_key,amount) VALUES(?,?,?,?)', {
        replacements: [uuid(), subscriptionId, moduleKey, Number(modulePrice[0]?.amount || 0)], transaction
      });
    }
  });
  return { organization_id: organizationId, subscription_id: subscriptionId, hostname: hostnameForSubdomain(selection.subdomain), plan: selection.plan, duration_months: selection.durationMonths, modules: selection.modules, amount: selection.totalAmount };
}

async function createPendingOrder({ organizationId, subscriptionId }) {
  const [rows] = await masterDb.query('SELECT * FROM subscriptions WHERE id=? AND org_id=? AND status IN ("pending","order_created") LIMIT 1', { replacements: [subscriptionId, organizationId] });
  if (!rows.length) throw Object.assign(new Error('Pending subscription not found'), { status: 404, code: 'SUBSCRIPTION_NOT_FOUND' });
  const subscription = rows[0];
  if (subscription.provider_order_id) {
    const [existing] = await masterDb.query('SELECT * FROM payment_orders WHERE provider_order_id=? LIMIT 1', { replacements: [subscription.provider_order_id] });
    if (existing.length) return { subscription_id: subscription.id, order: { id: existing[0].provider_order_id, amount: Math.round(Number(existing[0].amount) * 100), currency: existing[0].currency } };
  }
  const order = await createOrder({ amount: Math.round(Number(subscription.amount) * 100), currency: subscription.currency, receipt: `sub_${subscription.id}` });
  await masterDb.query('UPDATE subscriptions SET status="order_created",provider_order_id=? WHERE id=?', { replacements: [order.id, subscription.id] });
  await masterDb.query('INSERT INTO payment_orders(id,subscription_id,provider_order_id,amount,currency,status) VALUES(?,?,?,?,?,"created")', {
    replacements: [uuid(), subscription.id, order.id, subscription.amount, subscription.currency]
  });
  return { subscription_id: subscription.id, order };
}

async function activatePendingOrganization({ subscription, paymentId }) {
  const [orgRows] = await masterDb.query('SELECT * FROM organizations WHERE id=? LIMIT 1', { replacements: [subscription.org_id] });
  if (!orgRows.length) throw Object.assign(new Error('Organization not found'), { status: 404, code: 'ORGANIZATION_NOT_FOUND' });
  if (orgRows[0].status === 'active' && subscription.status === 'active') return { already_active: true, organization_id: orgRows[0].id };
  const organization = orgRows[0];
  await masterDb.query(
    `UPDATE provisioning_jobs
        SET status='provisioning', attempts=attempts+1, started_at=NOW(), last_error=NULL
      WHERE organization_id=? AND status IN ('pending','retry_pending','failed')`,
    { replacements: [organization.id] }
  );
  const [accountRows] = await masterDb.query('SELECT * FROM pending_organization_accounts WHERE organization_id=?', { replacements: [organization.id] });
  if (!accountRows.length) throw Object.assign(new Error('Pending administrator account not found'), { status: 500, code: 'ONBOARDING_ACCOUNT_MISSING' });
  const root = await mysql.createConnection({ host: process.env.MASTER_DB_HOST || 'localhost', port: Number(process.env.MASTER_DB_PORT || 3306), user: process.env.MASTER_DB_USER || 'root', password: process.env.MASTER_DB_PASS || '', multipleStatements: true });
  try {
    await root.query(`CREATE DATABASE IF NOT EXISTS \`${organization.db_name.replace(/`/g, '')}\``);
    await root.changeUser({ database: organization.db_name });
    await applyMigrationsToDb(root, organization.db_name, 'org');
    const [existingAdmins] = await root.query('SELECT id FROM users WHERE email=? LIMIT 1', [organization.owner_email]);
    const adminId = existingAdmins[0]?.id || uuid();
    if (!existingAdmins.length) {
      await root.query('INSERT INTO users(id,name,email,password_hash,role,is_active) VALUES(?,?,?,?,?,1)', [adminId, organization.owner_name, organization.owner_email, accountRows[0].owner_password_hash, 'admin']);
    }
    await root.end();
    const months = Math.max(1, Math.floor(Number(subscription.duration_months)));
    const [items] = await masterDb.query('SELECT module_key FROM subscription_items WHERE subscription_id=?', { replacements: [subscription.id] });
    const tx = await masterDb.transaction();
    try {
      await masterDb.query('UPDATE subscriptions SET status="active",provider_payment_id=?,starts_at=COALESCE(starts_at,NOW()),expires_at=DATE_ADD(NOW(), INTERVAL duration_months MONTH) WHERE id=?', { replacements: [paymentId, subscription.id], transaction: tx });
      await masterDb.query(`UPDATE organizations SET status="active",is_active=1,is_trial=0,plan_started_at=COALESCE(plan_started_at,NOW()),plan_expires_at=DATE_ADD(NOW(), INTERVAL ${months} MONTH) WHERE id=?`, { replacements: [organization.id], transaction: tx });
        await masterDb.query(
          `UPDATE provisioning_jobs SET status='provisioned', completed_at=NOW(), last_error=NULL WHERE organization_id=?`,
          { replacements: [organization.id], transaction: tx }
        );
      for (const item of items) await masterDb.query('INSERT INTO org_modules(org_id,module_key,is_active) VALUES(?,?,1) ON DUPLICATE KEY UPDATE is_active=1', { replacements: [organization.id, item.module_key], transaction: tx });
      await masterDb.query('DELETE FROM pending_organization_accounts WHERE organization_id=?', { replacements: [organization.id], transaction: tx });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    return { activated: true, organization_id: organization.id, slug: organization.slug, admin_id: adminId };
  } catch (error) {
    await masterDb.query(
      `UPDATE provisioning_jobs SET status='retry_pending', last_error=?, next_attempt_at=DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE organization_id=?`,
      { replacements: [error.message, organization.id] }
    ).catch(() => {});
    await root.end().catch(() => {});
    throw error;
  }
}

async function verifyPendingPayment(body) {
  if (!verifyPayment(body)) throw Object.assign(new Error('Payment signature verification failed'), { status: 400, code: 'PAYMENT_VERIFICATION_FAILED' });
  const [orders] = await masterDb.query('SELECT p.*, s.* FROM payment_orders p INNER JOIN subscriptions s ON s.id=p.subscription_id WHERE p.provider_order_id=? LIMIT 1', { replacements: [body.razorpay_order_id] });
  if (!orders.length) throw Object.assign(new Error('Payment order not found'), { status: 404, code: 'PAYMENT_ORDER_NOT_FOUND' });
  const order = orders[0];
  if (order.provider_order_id !== body.razorpay_order_id || order.currency !== 'INR') {
    throw Object.assign(new Error('Payment order or currency does not match the subscription'), { status: 400, code: 'PAYMENT_ORDER_MISMATCH' });
  }
  const payment = await fetchPayment(body.razorpay_payment_id);
  if (payment) {
    if (payment.order_id !== order.provider_order_id || Number(payment.amount) !== Math.round(Number(order.amount) * 100) || payment.currency !== order.currency) {
      throw Object.assign(new Error('Payment amount or currency does not match the subscription'), { status: 400, code: 'PAYMENT_AMOUNT_MISMATCH' });
    }
    if (!['authorized', 'captured'].includes(payment.status)) {
      throw Object.assign(new Error('Payment is not in a payable state'), { status: 409, code: 'PAYMENT_NOT_CAPTURED' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    throw Object.assign(new Error('Payment provider verification is unavailable'), { status: 503, code: 'PAYMENT_PROVIDER_UNAVAILABLE' });
  }
  if (isPaymentAlreadyProcessed(order)) return activatePendingOrganization({ subscription: order, paymentId: body.razorpay_payment_id });
  await masterDb.query('UPDATE payment_orders SET status="paid" WHERE provider_order_id=?', { replacements: [body.razorpay_order_id] });
  return activatePendingOrganization({ subscription: order, paymentId: body.razorpay_payment_id });
}

async function processPaymentWebhook(rawBody, signature) {
  if (!verifyWebhook(rawBody, signature)) throw Object.assign(new Error('Webhook signature verification failed'), { status: 400, code: 'WEBHOOK_VERIFICATION_FAILED' });
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw Object.assign(new Error('Invalid webhook payload'), { status: 400, code: 'INVALID_WEBHOOK_PAYLOAD' }); }
  const eventId = String(event.id || crypto.createHash('sha256').update(rawBody).digest('hex'));
  const [existing] = await masterDb.query('SELECT id FROM payment_events WHERE provider_event_id=? LIMIT 1', { replacements: [eventId] });
  if (existing.length) return { duplicate: true };
  try {
    await masterDb.query('INSERT INTO payment_events(id,provider,provider_event_id,event_type,payload) VALUES(?,?,?,?,?)', {
      replacements: [uuid(), 'razorpay', eventId, event.event || 'unknown', JSON.stringify(event)]
    });
  } catch (error) {
    if (error.original?.code === 'ER_DUP_ENTRY' || error.parent?.code === 'ER_DUP_ENTRY') return { duplicate: true };
    throw error;
  }
  const payment = event.payload?.payment?.entity;
  if (payment?.order_id && ['payment.captured', 'order.paid'].includes(event.event)) {
    const [orders] = await masterDb.query('SELECT p.*, s.* FROM payment_orders p INNER JOIN subscriptions s ON s.id=p.subscription_id WHERE p.provider_order_id=? LIMIT 1', { replacements: [payment.order_id] });
    if (orders.length) {
      if (Number(payment.amount) !== Math.round(Number(orders[0].amount) * 100) || payment.currency !== orders[0].currency) {
        throw Object.assign(new Error('Webhook payment amount or currency mismatch'), { status: 400, code: 'PAYMENT_AMOUNT_MISMATCH' });
      }
      await masterDb.query('UPDATE payment_orders SET status="paid" WHERE provider_order_id=?', { replacements: [payment.order_id] });
      await activatePendingOrganization({ subscription: orders[0], paymentId: payment.id });
    }
  }
  await masterDb.query('UPDATE payment_events SET processed_at=NOW() WHERE provider_event_id=?', { replacements: [eventId] });
  return { processed: true, event_id: eventId };
}

module.exports = {
  provisionOrganization, createPendingOrganization, createPendingOrder, verifyPendingPayment,
  processPaymentWebhook, validateSelection, activatePendingOrganization, isPaymentAlreadyProcessed, retryProvisionOrganization,
  provisioningFailureState
};
