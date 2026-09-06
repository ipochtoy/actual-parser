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
  async getAuthToken(interactive){assert.equal(interactive,false);return 'fixture-token';},
  async readSheetData(){h.reads++;options.beforeRead?.(h);return clone(h.rows);},
  async replayScreenshotLinks(){},async sendTelegramMessage(){},
  async writeDataToSheet(_id,_sheet,values){h.appends.push(clone(values));h.rows.push(...clone(values));},
  async fetch(url,request){assert.equal(url,'https://sheets.googleapis.com/v4/spreadsheets/fixture/values:batchUpdate');assert.equal(request.method,'POST');
   const body=JSON.parse(request.body);assert.equal(body.valueInputOption,'RAW');h.writes.push(body);
   if(options.httpError)return {ok:false,status:503,text:async()=> 'fixture failure'};
   for(const entry of body.data){const m=/^Лист1!([EJK])(\d+)$/.exec(entry.range);assert.ok(m,`Unexpected write: ${entry.range}`);if(!options.dropWrites)h.rows[Number(m[2])-1][{E:4,J:9,K:10}[m[1]]]=entry.values[0][0];}
   return {ok:true};},
  chrome:{storage:{local:{async get(){return clone(h.storage);},async set(patch){Object.assign(h.storage,clone(patch));}}},runtime:{sendMessage(message){h.messages.push(message);}}},
 };
 vm.createContext(context);vm.runInContext(upload,context);h.run=()=>context.uploadToSheets();return h;
}
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
