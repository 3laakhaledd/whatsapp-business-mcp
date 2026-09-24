import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BulkDelivery, normalizePhone } from '../src/bulk-delivery.mjs';
const base = { campaign_key: 'approved_test_01', source: 'Synthetic test snapshot', expected_records: 4, phone_number_id: '123', template_name: 'test', language_code: 'ar', components: [], recipients: ['+201012345678', '00201012345678', '+201112345678', 'bad'] };
async function setup(t, send = async () => ({ messages: [{ id: 'wamid.test' }] }), receipt) {
 const dir = await fs.mkdtemp(join(tmpdir(), 'wa-bulk-'));
 t.after(() => fs.rm(dir, { recursive: true, force: true }));
 return new BulkDelivery(dir, send, receipt, async () => {});
}
test('normalization and ambiguous number hold', () => {
 assert.equal(normalizePhone('٠١٠١٢٣٤٥٦٧٨'), '201012345678');
 assert.equal(normalizePhone('+966 55 101 2710'), '966551012710');
 assert.equal(normalizePhone('+20 50 5572569'), null);
 assert.equal(normalizePhone('abc201012345678'), null);
});
test('prepare is no-send, idempotent, immutable, count-checked and private', async t => {
 let sends=0; const e=await setup(t, async () => { sends++; });
 const p=await e.prepare(base); assert.equal(sends,0); assert.equal(p.unique_recipients,2); assert.equal(p.skipped_records,2);
 assert.deepEqual(await e.prepare(base),p);
 await assert.rejects(e.prepare({...base,expected_records:5}));
 await assert.rejects(e.prepare({...base,template_name:'changed'}));
 assert.equal((await fs.stat(e.path(p.batch_id))).mode & 0o777,0o600);
});
test('confirmation, bounded sending, resume without duplicates, delivery distinction', async t => {
 const sent=[]; const e=await setup(t,async b=>{sent.push(b.to);return {messages:[{id:'wamid.'+sent.length}]};},async id=>({status:id==='wamid.1'?'delivered':'unknown'}));
 const p=await e.prepare(base);
 await assert.rejects(e.run(p.batch_id,'bad',1)); assert.equal(sent.length,0);
 await e.run(p.batch_id,p.confirm_token,1); await e.run(p.batch_id,p.confirm_token,1); await e.run(p.batch_id,p.confirm_token,1);
 assert.deepEqual(sent,['+201012345678','+201112345678']);
 const r=await e.report(p.batch_id,0,1);
 assert.equal(r.submission_counts.accepted,2); assert.deepEqual(r.delivery_counts,{delivered:1,unknown:1}); assert.equal(r.next_offset,1);
});
test('network uncertainty halts and never retries',async t=>{
 let sent=0; const e=await setup(t,async()=>{sent++;throw new Error('timeout');});const p=await e.prepare(base);
 await e.run(p.batch_id,p.confirm_token,10); const r=await e.run(p.batch_id,p.confirm_token,10);
 assert.equal(sent,1); assert.equal(r.halted,true); assert.equal(r.counts.uncertain,1);assert.equal(r.counts.pending,1);
});
test('explicit rejection halts without retries',async t=>{
 let sent=0;const e=await setup(t,async()=>{sent++;return {error:{http_status:400,code:131030,message:'Rejected'}};}); const p=await e.prepare(base);
 await e.run(p.batch_id,p.confirm_token,10);await e.run(p.batch_id,p.confirm_token,10);
 assert.equal(sent,1);assert.equal((await e.report(p.batch_id)).submission_counts.failed,1);
});
test('crash intent remains uncertain and stale locks fail closed',async t=>{
 let sent=0;const e=await setup(t,async()=>{sent++;});const p=await e.prepare(base);const b=await e.load(p.batch_id);
 b.rows[0].state='attempting';await e.save(p.batch_id,b);
 await e.run(p.batch_id,p.confirm_token,1);assert.equal(sent,0);
 await fs.writeFile(e.path(p.batch_id)+'.lock','');await assert.rejects(e.run(p.batch_id,p.confirm_token,1),/Batch busy/);
});
test('concurrent runs cannot double-send and storage errors prevent network',async t=>{
 let release, entered;const gate=new Promise(r=>release=r), started=new Promise(r=>entered=r);let sent=0;
 const e=await setup(t,async()=>{sent++;entered();await gate;return {messages:[{id:'wamid.one'}]};});const p=await e.prepare(base);
 const running=e.run(p.batch_id,p.confirm_token,1);await started;await assert.rejects(e.run(p.batch_id,p.confirm_token,1),/Batch busy/);release();await running;assert.equal(sent,1);
 e.save=async()=>{throw new Error('disk full');};await assert.rejects(e.run(p.batch_id,p.confirm_token,1));assert.equal(sent,1);
});
