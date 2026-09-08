import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8');
const upload=source.slice(source.indexOf('async function uploadToSheets('),source.indexOf('async function triggerPochtoyAutoStart('));
assert.ok(upload.length>5000);
const clone=x=>structuredClone(x);
const row=(overrides={})=>Object.assign(['Amazon','111-0998916-5002605','TBA333393530628','Yorkshire Tea','1','','','archive-proof','photopochtoy@gmail.com','parser|2026-09-04T05:00:00.000Z','состав не разобран'],overrides);
const item=(overrides={})=>({store_name:'Amazon',order_id:'111-0998916-5002605',track_number:'TBA333393530628',product_name:'Yorkshire Tea',qty:'1',color:'',size:'',account_name:'photopochtoy@gmail.com',composition_parsed:true,...overrides});
function harness(rows=[row()],items=[item()],options={}){
 const h={rows:clone(rows),reads:0,writes:[],messages:[],storage:{orderData:{Amazon:{orders:clone(items)}},...options.storage},appends:[]};
 const context={Date,URL,console:{log(){},warn(){},error(){}},DEFAULT_SPREADSHEET_ID:'fixture',parseReport:{},
  normalizeAccountEmail: value=>String(value||'').trim().toLowerCase(),
  async getAuthToken(interactive){assert.equal(interactive,false);return 'fixture-token';},
  async readSheetData(){h.reads++;options.beforeRead?.(h);return clone(h.rows);},
  async replayScreenshotLinks(){},async sendTelegramMessage(){},
  async writeDataToSheet(_id,_sheet,values){h.appends.push(clone(values));h.rows.push(...clone(values));},
  async fetch(url,request){assert.equal(url,'https://sheets.googleapis.com/v4/spreadsheets/fixture/values:batchUpdate');assert.equal(request.method,'POST');
   const body=JSON.parse(request.body);assert.equal(body.valueInputOption,'RAW');h.writes.push(body);
   if(options.httpError)return {ok:false,status:503,text:async()=> 'fixture failure'};
   for(const entry of body.data){const m=(options.allowVariantWrite?/^Лист1!([EFGJK])(\d+)$/:/^Лист1!([EJK])(\d+)$/).exec(entry.range);assert.ok(m,`Unexpected write: ${entry.range}`);if(!options.dropWrites)h.rows[Number(m[2])-1][{E:4,F:5,G:6,J:9,K:10}[m[1]]]=entry.values[0][0];}
   return {ok:true};},
  chrome:{storage:{local:{async get(){return clone(h.storage);},async set(patch){Object.assign(h.storage,clone(patch));}}},runtime:{sendMessage(message){h.messages.push(message);}}},
 };
 vm.createContext(context);vm.runInContext(upload,context);h.run=()=>context.uploadToSheets(options.runId||null);return h;
}

function coordinatedUpload(overrides={}, rowOverrides={}) {
 const run={id:'early-night-run',status:'completed',source:'coordinator-control',
  slotAt:Date.parse('2026-09-06T23:00:00-04:00'),attemptedAt:Date.parse('2026-09-06T22:25:03.264-04:00'),
  startedAt:Date.parse('2026-09-06T22:25:03.314-04:00'),finishedAt:Date.parse('2026-09-06T23:08:49.270-04:00'),
  nightSlotDay:'2026-09-06',nightRequestToken:'night:2026-09-06:1788742805351',
  expected:{amazon:['photopochtoy@gmail.com']},...overrides};
 const observed=item({parser_run_id:run.id,parser_account:'photopochtoy@gmail.com',
  observed_at:new Date(run.startedAt+1000).toISOString(),...rowOverrides});
 return harness([], [observed], {runId:run.id,storage:{pipelineRun:run}});
}
for(const status of ['completed','degraded']) test(`coordinated 22:25 run can publish exact rows after ${status}`,async()=>{
 const h=coordinatedUpload({status});await h.run();assert.equal(h.appends.length,1);assert.equal(h.rows.length,1);
 assert.equal(h.rows[0][4],'1');assert.ok(h.messages.some(m=>m.status==='success'));
 await h.run();assert.equal(h.appends.length,1,'a retry keeps existing exact rows');
});
test('early same-night completion and winter New York offset also reach Sheets',async()=>{
 for(const patch of [
  {finishedAt:Date.parse('2026-09-06T22:45:00-04:00')},
  {slotAt:Date.parse('2026-12-06T23:00:00-05:00'),attemptedAt:Date.parse('2026-12-06T21:00:00-05:00'),
   startedAt:Date.parse('2026-12-06T21:00:00.100-05:00'),finishedAt:Date.parse('2026-12-06T22:45:00-05:00'),nightSlotDay:'2026-12-06'}
 ]) {const h=coordinatedUpload(patch);await h.run();assert.equal(h.appends.length,1)}
});
for(const [name,patch] of [
 ['legacy source',{source:'alarm'}],['missing token',{nightRequestToken:undefined}],['short token',{nightRequestToken:'x'}],
 ['wrong night',{nightSlotDay:'2026-09-05'}],['wrong hour',{slotAt:Date.parse('2026-09-06T22:59:00-04:00')}],
 ['noncanonical milliseconds',{slotAt:Date.parse('2026-09-06T23:00:00.001-04:00')}],
 ['before admission window',{attemptedAt:Date.parse('2026-09-06T20:59:59-04:00')}],
 ['reversed actual attempt',{attemptedAt:Date.parse('2026-09-06T22:26:00-04:00')}],
 ['finish before actual start',{finishedAt:Date.parse('2026-09-06T22:24:00-04:00')}],
]) test(`early upload refuses ${name} before a Sheets read or write`,async()=>{
 const h=coordinatedUpload(patch);await assert.rejects(h.run(),/invalid pipeline timestamps/);
 assert.equal(h.reads,0);assert.equal(h.appends.length,0);assert.equal(h.writes.length,0);
});
test('early admission keeps row account/time and current-run fences',async()=>{
 for(const rowPatch of [{parser_account:'foreign@example.com'},{observed_at:'2026-09-06T20:00:00-04:00'},
  {observed_at:'2026-09-07T06:00:00-04:00'}]) {
  const h=coordinatedUpload({},rowPatch);await assert.rejects(h.run(),/outside the run\/account\/time fence/);assert.equal(h.reads,0);
 }
 const h=coordinatedUpload();h.storage.pipelineRun.id='foreign-run';
 await assert.rejects(h.run(),/does not belong/);assert.equal(h.reads,0);
});
test('same item updates E and canonical K, stamps J, confirms readback, preserves F/G/H/I',async()=>{
 const before=row({4:'2',5:'DONE 123'}),h=harness([before]);await h.run();
 assert.equal(h.reads,3);assert.equal(h.rows[0][4],'1');assert.equal(h.rows[0][10],'');assert.match(h.rows[0][9],/^parser\|20/);assert.notEqual(h.rows[0][9],before[9]);
 for(const i of [0,1,2,3,5,6,7,8])assert.equal(h.rows[0][i],before[i]);
 assert.equal(h.storage.lastUpload.qtyUpdated,1);assert.ok(h.messages.some(m=>m.status==='success'));
});
test('K-only update records a new J; identical observation leaves J alone',async()=>{
 const h=harness();await h.run();assert.equal(h.storage.lastUpload.qtyUpdated,0);assert.deepEqual(h.writes[0].data.map(x=>x.range),['Лист1!J1','Лист1!K1']);
 const stamp=h.rows[0][9];h.writes=[];await h.run();assert.equal(h.writes.length,0);assert.equal(h.rows[0][9],stamp);
});
test('unknown composition cannot clear canonical K; unknown quantity never becomes one',async()=>{
 const h=harness([row()],[item({composition_parsed:undefined})]);await h.run();assert.equal(h.rows[0][10],'состав не разобран');assert.equal(h.writes.length,0);
 const q=harness([row({10:''})],[item({qty:null,composition_parsed:false})]);await q.run();assert.equal(q.rows[0][4],'');assert.equal(q.rows[0][10],'состав не разобран');
});
test('custom K is preserved and never included in the write request',async()=>{
 const h=harness([row({4:'2',10:'operator: check parcel'})]);await h.run();assert.equal(h.rows[0][10],'operator: check parcel');assert.ok(h.writes[0].data.every(x=>!x.range.includes('!K')));
});
test('equivalent historical copies are updated together without deleting archive links or DONE',async()=>{
 const h=harness([row({4:'2',5:'DONE 111',7:'archive-A'}),row({4:'2',7:'archive-B'})]);await h.run();assert.equal(h.rows.length,2);
 assert.deepEqual(h.rows.map(r=>r[4]),['1','1']);assert.deepEqual(h.rows.map(r=>r[10]),['','']);assert.deepEqual(h.rows.map(r=>r[7]),['archive-A','archive-B']);assert.equal(h.rows[0][5],'DONE 111');assert.equal(h.storage.lastUpload.qtyUpdated,2);
});
test('copies differing only in empty/canonical K converge; already-correct copy keeps its J',async()=>{
 const correct=row({10:'',9:'parser|old-correct'}),h=harness([row(),correct]);await h.run();assert.deepEqual(h.rows.map(r=>r[10]),['','']);assert.equal(h.rows[1][9],correct[9]);
});
for(const quantities of [['2','1'],['1','1','','1']]){
 test(`live-shaped conflicting quantities ${JSON.stringify(quantities)} require complete exact item`,async()=>{
  const rows=quantities.map(qty=>row({4:qty,10:''}));
  for(const overrides of [{composition_parsed:false},{composition_parsed:undefined},{qty:null},{qty:'0'},{qty:'1.5'}]){
   const h=harness(rows,[item(overrides)]);await assert.rejects(h.run(),/require a complete exact Parser item/);assert.equal(h.writes.length,0);assert.deepEqual(h.rows,rows);assert.equal(h.storage.lastUpload,undefined);
  }
  const proved=harness(rows);await proved.run();assert.ok(proved.rows.every(r=>r[4]==='1'));assert.equal(proved.rows.length,quantities.length);
 });
}
test('conflicting or mismatched size/color and conflicting custom notes are not silently merged',async()=>{
 for(const rows of [[row(),row({6:'XL'})],[row({6:'XL'})],[row({5:'red'}),row({5:'blue'})],[row({5:'red'})],[row(),row({10:'operator note'})]]){
  const h=harness(rows);await assert.rejects(h.run(),/Ambiguous variant|Conflicting custom/);assert.equal(h.writes.length,0);
 }
});
for (const example of [
 { count: 5, order: '13-15114-11126', track: '9434608106244517838177', product: 'Paul Mitchell The Color Permanent Cream Hair Color N/N+ Shades FASTEST SHIPPING', color: '' },
 { count: 2, order: '07-15122-65815', track: '9400108106245537447330', product: 'Travel Adventure Archive Shadow Box For Memories Keepsake Box With Slot On Top', color: 'Black' },
]) {
 test(`actual eBay repeated group ${example.order} preserves existing and new positions`, async () => {
  const items = Array.from({ length: example.count }, () => item({ store_name: 'eBay', order_id: example.order,
   track_number: example.track, product_name: example.product, color: example.color, account_name: 'ipochtoy@gmail.com' }));
  const rows = items.map((it, index) => row({ 0: it.store_name, 1: it.order_id, 2: it.track_number,
   3: it.product_name, 5: it.color, 7: `archive-${index}`, 8: it.account_name, 10: '' }));
  const unchanged = harness(rows, items); await unchanged.run();
  assert.deepEqual(unchanged.rows, rows); assert.equal(unchanged.writes.length, 0); assert.equal(unchanged.appends.length, 0);
  const fresh = harness([], items); await fresh.run();
  assert.equal(fresh.rows.length, example.count); assert.equal(fresh.appends[0].length, example.count);
  assert.ok(fresh.rows.every(r => r[4] === '1' && r[5] === example.color));
  const again = harness(fresh.rows, items); await again.run();
  assert.deepEqual(again.rows, fresh.rows); assert.equal(again.writes.length, 0); assert.equal(again.appends.length, 0);
  for (const changed of [rows.slice(1), [...rows, clone(rows[0])],
   rows.map((r, i) => i ? r : Object.assign([...r], { 4: '2' })),
   rows.map((r, i) => i ? r : Object.assign([...r], { 5: 'another color' })),
   rows.map((r, i) => i ? r : Object.assign([...r], { 6: 'XL' })),
   rows.map((r, i) => i ? r : Object.assign([...r], { 10: 'operator note' }))]) {
   const refused = harness(changed, items);
   await assert.rejects(refused.run(), /Ambiguous changed or repeated Parser item/);
   assert.equal(refused.writes.length, 0); assert.equal(refused.appends.length, 0); assert.deepEqual(refused.rows, changed);
  }
 });
}
test('repeated variants compare as an unchanged multiset, without summing or relying on order', async () => {
 const rows = [row({ 4: '2', 5: 'Black', 10: '' }), row({ 5: 'Red', 10: '' })];
 const h = harness(rows, [item({ color: 'Red' }), item({ qty: '2', color: 'Black' })]);
 await h.run(); assert.deepEqual(h.rows, rows); assert.equal(h.writes.length, 0); assert.equal(h.appends.length, 0);
});

function variantCorrection(colors = ['Black', 'White'], oldColor = 'Black', options = {}) {
 const run = { ...coordinatedUpload().storage.pipelineRun, expected: { ebay: ['buyer@example.test'] } };
 const items = colors.map((color, index) => item({ store_name: 'eBay', order_id: '11-11111-11111',
  track_number: '9434608106244517838177', color, account_name: 'buyer@example.test',
  parser_run_id: run.id, parser_account: 'buyer@example.test', observed_at: new Date(run.startedAt + 1000).toISOString(),
  ebay_item_identity: { schema: 1, source: 'purchase-feed-item-card', orderId: '11-11111-11111',
   itemId: '123456789012', transactionId: String(10000000000001 + index), variationId: String(600000000001 + index),
   track: '9434608106244517838177', color, size: '' },
 }));
 const rows = items.map(it => row({ 0: 'eBay', 1: it.order_id, 2: it.track_number, 3: it.product_name,
  5: oldColor, 7: '', 8: it.account_name, 10: '' }));
 options.mutate?.(rows, items, run);
 return harness(rows, items, { ...options, runId: run.id, storage: { pipelineRun: run }, allowVariantWrite: true });
}

test('exact feed identities restore two colors or five shades in interchangeable legacy copies', async () => {
 for (const [colors, oldColor] of [[['Black', 'White'], 'Black'], [['20 Volume', '10 Volume', '6n', '5ch+', '5n'], '']]) {
  const h = variantCorrection(colors, oldColor), before = clone(h.rows);
  await h.run();
  assert.deepEqual(h.rows.map(r => r[5]), colors);
  assert.equal(h.rows.length, before.length); assert.equal(h.appends.length, 0);
  assert.equal(h.storage.lastUpload.qtyUpdated, 0);
  for (let i = 0; i < before.length; i++) for (const column of [0,1,2,3,4,6,7,8,10]) assert.equal(h.rows[i][column], before[i][column]);
  assert.ok(h.writes.flatMap(w => w.data).every(e => /!F\d+$|!J\d+$/.test(e.range)));
  h.writes = []; const corrected = clone(h.rows); await h.run();
  assert.deepEqual(h.rows, corrected); assert.equal(h.writes.length, 0);
 }
});

test('legacy variant correction refuses unbound identities and distinguishable or processed copies', async () => {
 const mutations = [
  (rows, items) => { delete items[0].ebay_item_identity; },
  (rows, items) => { items[1].ebay_item_identity.transactionId = items[0].ebay_item_identity.transactionId; },
  (rows, items) => { items[1].ebay_item_identity.orderId = 'foreign'; },
  (rows, items) => { items[1].ebay_item_identity.track = 'foreign'; },
  (rows, items) => { items[1].ebay_item_identity.color = 'foreign'; },
  (rows, items) => { items[1].qty = '2'; },
  (rows, items) => { items[1].qty = null; },
  rows => { rows[0][7] = 'archive-proof'; },
  rows => { rows.forEach(r => { r[5] = 'DONE 123'; }); },
  rows => { rows[0][9] = 'operator correction'; },
  rows => { rows[0][10] = 'operator note'; },
  rows => { rows[0][6] = 'large'; },
  rows => { rows.pop(); },
  rows => { rows.push(clone(rows[0])); },
 ];
 for (const mutate of mutations) {
  const h = variantCorrection(['Black', 'White'], 'Black', { mutate }), before = clone(h.rows);
  await assert.rejects(h.run(), /Ambiguous changed or repeated Parser item/);
  assert.deepEqual(h.rows, before); assert.equal(h.writes.length, 0); assert.equal(h.appends.length, 0);
 }
});

test('the same exact legacy correction can restore sizes without altering colors or quantity', async () => {
 const h = variantCorrection(['M', 'L'], '', { mutate(rows, items) {
  rows.forEach(r => { r[6] = 'M'; });
  items.forEach(it => { it.size = it.color; it.color = ''; it.ebay_item_identity.size = it.size; it.ebay_item_identity.color = ''; });
 } });
 await h.run(); assert.deepEqual(h.rows.map(r => r[6]), ['M', 'L']);
 assert.ok(h.rows.every(r => r[4] === '1' && r[5] === ''));
 assert.ok(h.writes.flatMap(w => w.data).every(e => /!G\d+$|!J\d+$/.test(e.range)));
});

test('one untouched eBay shoe row can recover its own proved size from an old sibling size', async () => {
 const h = variantCorrection(['US 10'], '', { mutate(rows, items) {
  rows[0][6] = 'XL'; items[0].size = items[0].color; items[0].color = '';
  items[0].ebay_item_identity.size = items[0].size; items[0].ebay_item_identity.color = '';
 } });
 await h.run(); assert.equal(h.rows[0][6], 'US 10'); assert.equal(h.rows[0][4], '1');
 assert.deepEqual(h.writes.flatMap(w => w.data).map(e => e.range).sort(), ['Лист1!G1', 'Лист1!J1']);
});

test('single legacy variant repair cannot erase a known field or touch an archive, note, or quantity', async () => {
 for (const mutate of [rows => rows[0][6]='XL', rows=>rows[0][7]='archive', rows=>rows[0][10]='operator note', rows=>rows[0][4]='2']) {
  const h=variantCorrection(['Black'], 'White', { mutate });
  await assert.rejects(h.run(),/Ambiguous/); assert.equal(h.writes.length,0); assert.equal(h.appends.length,0);
 }
});

test('variant correction rechecks exact copies and confirms all preserved cells after writing', async () => {
 const raced = variantCorrection(['Black', 'White'], 'Black', { beforeRead(h) { if (h.reads === 2) h.rows[0][7] = 'late-proof'; } });
 await assert.rejects(raced.run(), /changed before/); assert.equal(raced.writes.length, 0);
 const lost = variantCorrection(['Black', 'White'], 'Black', { dropWrites: true });
 await assert.rejects(lost.run(), /readback was not confirmed/); assert.equal(lost.storage.lastUpload, undefined);
});
test('fresh pre-write read rejects moved, changed or newly duplicated rows',async()=>{
 for(const mutate of [h=>h.rows.unshift(row({1:'another-order'})),h=>h.rows[0][4]='3',h=>h.rows.push(row())]){
  const h=harness([row()],[item()],{beforeRead(h){if(h.reads===2)mutate(h);}});await assert.rejects(h.run(),/changed before/);assert.equal(h.writes.length,0);assert.equal(h.storage.lastUpload,undefined);
 }
});
test('failed HTTP or unconfirmed post-read cannot emit success or publish update counts',async()=>{
 for(const options of [{httpError:true},{dropWrites:true},{beforeRead(h){if(h.reads===3)h.rows.push(row());}}]){
  const h=harness([row()],[item()],options);await assert.rejects(h.run(),/update failed|readback was not confirmed/);assert.ok(h.messages.every(m=>m.status!=='success'));assert.equal(h.storage.lastUpload,undefined);
 }
});
test('financial duplicate path remains separate from warehouse E/J/K updates',async()=>{
 const h=harness([row({0:'Amazon'})],[item()],{storage:{parseMode:'financial'}});await h.run();assert.equal(h.writes.length,0);assert.equal(h.reads,1);assert.equal(h.rows[0][10],'состав не разобран');
});
