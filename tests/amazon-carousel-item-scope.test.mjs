import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const source=fs.readFileSync(new URL('../content-amazon.js',import.meta.url),'utf8');
const scopeSource=fs.readFileSync(new URL('../shipment-scope.js',import.meta.url),'utf8');
const fixture=fs.readFileSync(new URL('./fixtures/amazon-carousel-order.html',import.meta.url),'utf8');
const block=(a,b)=>{const x=source.indexOf(a),y=source.indexOf(b,x);assert.ok(x>=0&&y>x);return source.slice(x,y);};
const actual=[block('  function findProductAnchors(','  async function fetchTrackingFromShipTrackUrl('),block('  async function parseIndividualItemSimpleByTrackUrl(','  async function getTracksForShipment('),block('  function getOrderCards(','  // ========== PAGINATION')].join('\n');
const bootstrap=`const SHIPMENT=globalThis.PPShipmentScope;const PARSE_MODE='warehouse';const sleep=async()=>{};const htmlDecode=s=>{const t=document.createElement('textarea');t.innerHTML=s||'';return t.value.trim()};const safeJSON=s=>{try{return JSON.parse(s)}catch{return null}};const bySel=(r,s)=>Array.from(r.querySelectorAll(s));const sendLog=()=>{};const getAmazonAccount=async()=>'fixture@example.invalid';const fetchTrackingFromShipTrackUrl=async()=>['TBA000000001'];const queueAmazonTrackScreenshot=async()=>{};const chrome={runtime:{sendMessage(){}},storage:{local:{get:async()=>({multiAccountState:{currentAmazonAccount:'fixture@example.invalid'}})}}};`;
test('carousel capture fixture retains separate physical rows and no private identities',()=>{
 assert.match(fixture,/a-carousel-card/);assert.match(fixture,/yo-enhanced-card-image/);
 assert.doesNotMatch(fixture,/@|114-1061608|ipochtoy|New Castle|SHIPMENT_PROOF|SiegeClientSideDecryption/i);
});
test('actual parser binds carousel images, titles and quantities to each physical item', {skip:!process.env.PARSER_PRO_PLAYWRIGHT_MODULE}, async()=>{
 const {chromium}=await import(pathToFileURL(process.env.PARSER_PRO_PLAYWRIGHT_MODULE).href);
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext();await context.route('**/*',r=>r.abort());const page=await context.newPage();
  const run=async mutation=>{await page.setContent(fixture);if(mutation)await page.evaluate(mutation);await page.addScriptTag({content:scopeSource});await page.addScriptTag({content:bootstrap+actual});return page.evaluate(async()=>{const result=await parseAmazonOrders();return result.orders.map(r=>({name:r.product_name,qty:r.qty,parsed:r.composition_parsed,reason:r.composition_reason}));});};
  const rows=await run();assert.equal(rows.length,3);assert.deepEqual(rows.map(x=>x.name),['Exact first product title','Exact second product title','Exact first product title']);assert.deepEqual(rows.map(x=>x.qty),['1','2','3']);assert.ok(rows.every(x=>x.parsed));
  const unknown=await run(()=>document.querySelector('.product-image__qty').textContent='?');assert.deepEqual(unknown.map(x=>x.qty),['1',null,'3']);assert.ok(unknown.every(x=>!x.parsed&&x.reason.includes('empty-qty')));
  const conflicting=await run(()=>{const a=document.createElement('a');a.href='https://www.amazon.com/dp/B0FOREIGN1';a.textContent='Other product in the same physical row';document.querySelector('.yo-enhanced-card').append(a);});assert.deepEqual(conflicting.map(x=>x.qty),[null,null,'2','3']);assert.ok(conflicting.every(x=>!x.parsed));
  const foreign=await run(()=>{const a=document.querySelector('a[href*="progress-tracker"]');a.href=a.href.replace('111-1111111-1111111','222-2222222-2222222');});assert.ok(foreign.every(x=>!x.parsed&&x.reason.includes('track-order-context-unproven')));
 }finally{await browser.close();}
});
