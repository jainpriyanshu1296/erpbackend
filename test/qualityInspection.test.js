const test=require('node:test');
const assert=require('node:assert/strict');
const {quantities,processResult,requireInspectionSource}=require('../src/services/qualityInspection.service');

function fixture({prior=0,legacy=false,source=true}={}) {
  const state={stock:0,value:0,ledger:0,commits:0,rollbacks:0,result:null,status:'pending'};
  const db={
    transaction:async()=>({commit:async()=>{state.commits++;},rollback:async()=>{state.rollbacks++;}}),
    query:async(sql,{replacements:r=[]}={})=>{
      if(sql.startsWith('SELECT * FROM qc_inspections')) return [[{id:'qc',inspection_type:'incoming',reference_id:'grn',item_id:'item',inspected_qty:10,accepted_qty:8,rejected_qty:2,status:state.status}]];
      if(sql.startsWith('SELECT result_json')) return [state.result?[{result_json:state.result}]:[]];
      if(sql.startsWith('SELECT g.id')) return [source?[{id:'grn',warehouse_id:'wh',quantity:10,rate:5}]:[]];
      if(sql.startsWith('SELECT id FROM grn')) return [[{id:'grn'}]];
      if(sql.includes('SUM(inspected_qty)')) {assert.match(sql,/FOR UPDATE/);return [[{quantity:prior}]];}
      if(sql.startsWith('SELECT COUNT(*) count FROM stock_ledger')) return [[{count:legacy?1:0}]];
      if(sql.startsWith('SELECT setting_value FROM company_settings')) return [[]];
      if(sql.startsWith('SELECT id FROM stock_effects')) return [[]];
      if(sql.startsWith('SELECT current_qty,avg_rate,total_value')) return [[{current_qty:state.stock,avg_rate:5,total_value:state.value}]];
      if(sql.startsWith('INSERT INTO stock_summary')) {state.stock=r[2];state.value=r[4];return [];}
      if(sql.startsWith('INSERT INTO stock_ledger')) {state.ledger++;return [];}
      if(sql.startsWith('INSERT INTO stock_effects')) return [];
      if(sql.startsWith('UPDATE qc_inspections')) {state.status='processed';return [];}
      if(sql.startsWith('INSERT INTO operation_keys')) {state.result=r[2];return [];}
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  return {db,state};
}
test('QC quantity validation rejects nonfinite values and mismatched totals',()=>{
  assert.deepEqual(quantities(10,8,2),{inspected:10,accepted:8,rejected:2});
  for(const value of [NaN,Infinity,-1]) assert.throws(()=>quantities(10,value,2));
  assert.throws(()=>quantities(10,9,2));
});
test('Incoming QC credits accepted stock with receipt valuation exactly once',async()=>{
  const {db,state}=fixture();
  await processResult(db,'qc',{},'user');
  assert.equal(state.stock,8);assert.equal(state.value,40);assert.equal(state.ledger,1);
  assert.equal((await processResult(db,'qc',{},'user')).already_applied,true);
  assert.equal(state.ledger,1);
  await assert.rejects(processResult(db,'qc',{accepted_qty:9},'user'),/cannot be changed/);
});
test('QC rejects missing item ownership and over-inspection before stock writes',async()=>{
  const missing=fixture({source:false});
  await assert.rejects(requireInspectionSource(missing.db,'incoming','grn','foreign'),/selected item/);
  const over=fixture({prior:1});
  await assert.rejects(processResult(over.db,'qc',{},'user'),/already been inspected/);
  assert.equal(over.state.stock,0);assert.equal(over.state.ledger,0);assert.equal(over.state.rollbacks,1);
});
test('legacy receipts already credited to inventory are not credited again',async()=>{
  const {db,state}=fixture({legacy:true});
  await processResult(db,'qc',{},'user');
  assert.equal(state.ledger,0);assert.equal(state.status,'processed');
});
