const test = require('node:test');
const assert = require('node:assert/strict');
const master = require('../src/config/db');
const { validateSelection } = require('../src/services/onboarding.service');
const cms = require('../src/services/cms.service');
const {provisionOrganization} = require('../src/services/onboarding.service');
const {validateIdentity} = require('../src/utils/provisioningValidation');
const {postPhysicalCount} = require('../src/services/zeroGapClosure.service');

test('invalid admin plans never provision a free organization and retain field errors', async () => {
  const identity={company_name:'Test company',owner_email:'owner@example.test',password:'secure-test-only',slug:'test-company',duration_months:1};
  for (const plan of ['invalid','',null,undefined]) {
    await assert.rejects(provisionOrganization({...identity,plan}),error=>error.code==='INVALID_PLAN_SELECTION' && typeof error.details.plan==='string');
    await assert.rejects(validateSelection({subdomain:identity.slug,plan,duration_months:1}),error=>error.code==='INVALID_PLAN_SELECTION' && typeof error.details.plan==='string');
  }
  assert.throws(()=>validateIdentity({...identity,owner_email:'invalid',password:'short'}),error=>Boolean(error.details.owner_email && error.details.password));
});

test('CMS validates all published fields and rejects arbitrary fields and invalid email', () => {
  assert.deepEqual(cms.validate(cms.defaults),cms.defaults);
  assert.throws(()=>cms.validate({...cms.defaults,contact_email:'bad'}),/contact email/);
  assert.throws(()=>cms.validate({...cms.defaults,script:'bad'}),/Unknown/);
  assert.throws(()=>cms.validate({...cms.defaults,features:[]}),/features/);
});
test('billing conflicts are rejected before any database access', async () => {
  await assert.rejects(validateSelection({plan:'pro',plan_code:'free'}),/Conflicting plan codes/);
  await assert.rejects(validateSelection({plan:'pro',duration_months:12,durationMonths:1}),/Conflicting billing durations/);
  await assert.rejects(validateSelection({plan:'pro',duration_months:1,billing_period:'annual'}),/disagree/);
  await assert.rejects(validateSelection({plan_id:'not-an-id'}),/Invalid plan price ID/);
});
test('free is explicit and valid while missing or unknown plans fail closed',async()=>{
  const original=master.query;master.query=async sql=>sql.includes('reserved_subdomains')||sql.includes('organization_domains')?[[]]:(()=>{throw Error(`Unexpected query ${sql}`)})();
  try {
    assert.equal((await validateSelection({subdomain:'free-tenant',plan:'free',duration_months:1})).totalAmount,0);
    for(const plan of [undefined,'unknown','']) await assert.rejects(validateSelection({subdomain:'invalid-tenant',plan,duration_months:1}),error=>error.code==='INVALID_PLAN_SELECTION');
  } finally {master.query=original;}
});
test('valid plan price resolves one canonical duration and invalid ID is rejected', async () => {
  const original = master.query;
  master.query = async (sql,options) => {
    if (sql.includes('WHERE id=?')) return options.replacements[0]===7 ? [[{plan:'pro',duration_months:12}]] : [[]];
    if (sql.includes('reserved_subdomains') || sql.includes('organization_domains')) return [[]];
    if (sql.includes('SELECT amount FROM plan_pricing')) return [[{amount:1200}]];
    throw Error('Unexpected query');
  };
  try {
    const selection = await validateSelection({subdomain:'local-test',plan_id:7,billing_period:'annual'});
    assert.equal(selection.plan,'pro'); assert.equal(selection.durationMonths,12); assert.equal(selection.totalAmount,1200);
    await assert.rejects(validateSelection({subdomain:'local-test',plan_id:8}),/unavailable/);
    await assert.rejects(validateSelection({subdomain:'local-test',plan_id:7,plan:'free'}),/does not match/);
  } finally { master.query = original; }
});

test('physical count posting and replay keep stock, ledger, effect, and audit idempotent', async () => {
  const state={status:'approved',qty:5,effect:false,ledger:0,audit:0,commits:0};
  const tx={commit:async()=>{state.commits++;},rollback:async()=>{}};
  const db={transaction:async()=>tx,query:async(sql,options={})=>{
    assert.equal(options.transaction,tx);
    if(sql.startsWith('SELECT * FROM physical_counts')) return [[{id:'count-1',status:state.status,warehouse_id:'warehouse-1'}]];
    if(sql.startsWith('SELECT * FROM physical_count_lines')) return [[{id:'line-1',item_id:'item-1',system_qty:5,counted_qty:7}]];
    if(sql.startsWith('SELECT current_qty FROM stock_summary')) return [[{current_qty:state.qty}]];
    if(sql.startsWith('SELECT id FROM stock_effects')) return [state.effect?[{id:'effect-1'}]:[]];
    if(sql.startsWith('SELECT current_qty,avg_rate,total_value')) return [[{current_qty:state.qty,avg_rate:0,total_value:0}]];
    if(sql.startsWith('INSERT INTO stock_summary')) {state.qty=7;return [[]];}
    if(sql.startsWith('INSERT INTO stock_ledger')) {state.ledger++;return [[]];}
    if(sql.startsWith('INSERT INTO stock_effects')) {state.effect=true;return [[]];}
    if(sql.startsWith('UPDATE physical_counts')) {state.status='posted';return [[]];}
    if(sql.startsWith('INSERT INTO audit_events')) {state.audit++;assert.deepEqual(options.replacements.slice(2,6),['zero_gap_closure','physical_count_posted','physical_count','count-1']);return [[]];}
    throw new Error(`Unexpected query: ${sql}`);
  }};
  assert.equal((await postPhysicalCount(db,'count-1','user-1')).status,'posted');
  assert.equal((await postPhysicalCount(db,'count-1','user-1')).already_applied,true);
  assert.deepEqual({qty:state.qty,ledger:state.ledger,audit:state.audit},{qty:7,ledger:1,audit:1});
});
