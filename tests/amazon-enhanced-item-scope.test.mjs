import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
const source=fs.readFileSync(new URL('../content-amazon.js',import.meta.url),'utf8');
const scopeSource=fs.readFileSync(new URL('../shipment-scope.js',import.meta.url),'utf8');
const fixture=fs.readFileSync(new URL('./fixtures/amazon-enhanced-flex-order.html',import.meta.url),'utf8');
const block=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b)};
const asinFunction=block('  function extractASINFromLink(','  function closestItemScope(');
const titleFunction=block('  function extractTitleForAmazonProduct(','  function collectNearbyJSON(');
function titleContext(){const c={SHIPMENT:{PRODUCT_LINK_SELECTOR:'product'}};vm.createContext(c);vm.runInContext(asinFunction+titleFunction,c);return c;}
function link(asin,text='',alt=''){return{href:`https://www.amazon.com/dp/${asin}`,getAttribute:()=>`/dp/${asin}`,textContent:text,title:'',querySelector:()=>alt?{alt}:null};}
test('actual product title is bound to its ASIN even when scope also contains another product',()=>{
 const c=titleContext(),foreign=link('B0SAMPLE01','Neighbour title'),own=link('B0SAMPLE02','Exact product title');
 assert.equal(c.extractTitleForAmazonProduct({querySelectorAll:()=>[foreign,own]},own),'Exact product title');
 const image=link('B0SAMPLE02');assert.equal(c.extractTitleForAmazonProduct({querySelectorAll:()=>[foreign,image,own]},image),'Exact product title');
 assert.equal(c.extractTitleForAmazonProduct({querySelectorAll:()=>[foreign,image]},image),'Product ASIN: B0SAMPLE02');
 const noAsin={...own,href:'https://www.amazon.com/',getAttribute:()=>'/'};
 assert.equal(c.extractTitleForAmazonProduct({querySelectorAll:()=>[foreign]},noAsin),'');
});
test('sanitized capture retains enhanced physical frames and contains no original private identities',()=>{
 assert.match(fixture,/yo-enhanced-flex-card/);assert.match(fixture,/a-fixed-left-grid-inner/);
 assert.doesNotMatch(fixture,/@|TBA\d|111-8440692|ipochtoy|Cruel Paradise|Perfect Strangers|1733824375/i);
});
const actual=[block('  function findProductAnchors(','  async function fetchTrackingFromShipTrackUrl('),block('  async function parseIndividualItemSimpleByTrackUrl(','  async function getTracksForShipment('),block('  function getOrderCards(','  // ========== PAGINATION')].join('\n');
const bootstrap=`const SHIPMENT=globalThis.PPShipmentScope;const PARSE_MODE='warehouse';const sleep=async()=>{};const htmlDecode=s=>{const t=document.createElement('textarea');t.innerHTML=s||'';return t.value.trim()};const safeJSON=s=>{try{return JSON.parse(s)}catch{return null}};const bySel=(r,s)=>Array.from(r.querySelectorAll(s));const sendLog=()=>{};const getAmazonAccount=async()=>'fixture@example.invalid';const fetchTrackingFromShipTrackUrl=async url=>['TBA00000000'+(new URL(url).searchParams.get('shipmentId')||'x')];const queueAmazonTrackScreenshot=async()=>{};const chrome={runtime:{sendMessage(){}},storage:{local:{get:async()=>({multiAccountState:{currentAmazonAccount:'fixture@example.invalid'}})}}};`;
test('actual page parser handles captured enhanced items, siblings, unknown quantities and exact shipment boundaries', {skip:!process.env.PARSER_PRO_PLAYWRIGHT_MODULE}, async()=>{
 const {chromium}=await import(pathToFileURL(process.env.PARSER_PRO_PLAYWRIGHT_MODULE).href);const browser=await chromium.launch({headless:true});
 try{const c=await browser.newContext();await c.route('**/*',r=>r.abort());const p=await c.newPage();
 const run=async mutation=>{await p.setContent(fixture);if(mutation)await p.evaluate(mutation);await p.addScriptTag({content:scopeSource});await p.addScriptTag({content:bootstrap+actual});return p.evaluate(async()=>{const r=await parseAmazonOrders();return r.orders.map(o=>({name:o.product_name,qty:o.qty,parsed:o.composition_parsed,reason:o.composition_reason,track:o.track_number}))})};
 const baseline=await run();assert.deepEqual(baseline.map(x=>x.name),['Fixture Book One','Fixture Book Two','Fixture Book Three','Fixture Book Four']);assert.ok(baseline.every(x=>x.qty==='1'&&x.parsed));assert.equal(new Set(baseline.map(x=>x.track)).size,2);
 const badge=await run(()=>{const b=document.createElement('span');b.className='product-image__qty';b.textContent='2';document.querySelectorAll('.yo-enhanced-flex-card')[1].append(b)});assert.deepEqual(badge.map(x=>x.qty),['1','1','2','1']);
 const unknown=await run(()=>{const b=document.createElement('span');b.className='product-image__qty';b.textContent='?';document.querySelectorAll('.yo-enhanced-flex-card')[1].append(b)});assert.deepEqual(unknown.map(x=>x.qty),['1','1',null,'1']);assert.equal(unknown[0].parsed,true);assert.ok(unknown.slice(1).every(x=>!x.parsed&&x.reason.includes('empty-qty')));
 const shared=await run(()=>document.querySelectorAll('.yo-enhanced-flex-card').forEach(x=>x.classList.remove('yo-enhanced-flex-card')));assert.deepEqual(shared.map(x=>x.name),baseline.map(x=>x.name));assert.ok(shared.slice(1).every(x=>x.qty===null&&!x.parsed));
 const foreign=await run(()=>{const b=document.querySelectorAll('a[href*="progress-tracker"]')[1];b.href=b.href.replace('111-1111111-1111111','222-2222222-2222222')});assert.ok(foreign.slice(1).every(x=>!x.parsed&&x.reason.includes('track-order-context-unproven')));
 const repeated=await run(()=>{const item=document.querySelector('.yo-enhanced-flex-card');item.parentElement.append(item.cloneNode(true))});assert.equal(repeated.length,5);assert.equal(repeated.filter(x=>x.name==='Fixture Book Two').length,2);
 const mixed=await run(()=>{const a=document.createElement('a');a.href='https://www.amazon.com/dp/B0FOREIGN1';a.textContent='Foreign product';document.querySelector('.yo-enhanced-flex-card').append(a)});assert.ok(mixed.filter(x=>['Fixture Book Two','Foreign product'].includes(x.name)).every(x=>x.qty===null&&!x.parsed));
 }finally{await browser.close()}
});
