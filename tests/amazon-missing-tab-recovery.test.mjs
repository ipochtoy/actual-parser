import { installParserComponentAdmission } from './helpers/parser-normal-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8');
const content=fs.readFileSync(new URL('../content-amazon.js',import.meta.url),'utf8');
function fn(name){
 const re=new RegExp('^(?:async )?function '+name+'\\(','m'),start=source.search(re);assert.notEqual(start,-1,name);
 let i=source.indexOf('(',start),depth=1;while(depth){i++;if(source[i]==='(')depth++;if(source[i]===')')depth--;}
 const body=source.indexOf('{',i);depth=1;i=body;while(depth){i++;if(source[i]==='{')depth++;if(source[i]==='}')depth--;}
 return source.slice(start,i+1);
}
const clone=x=>structuredClone(x), now=1788749400000;
function initial(){const start=now-1200000;return {
 pipelineRun:{id:'run-exact',status:'running',expected:{amazon:['a@example.com','b@example.com']},completed:{amazon:['other@example.com']},failures:[]},
 pipelineStage:{runId:'run-exact',active:true,startedAt:start-60000,stageStartedAt:start-30000,currentIndex:2,stages:['iherb','ebay','amazon','done']},
 multiAccountState:{isMultiAccountParsing:true,currentAmazonAccount:'a@example.com',amazonAccountsQueue:['b@example.com']},
 amazonParserTabId:9,accountSwitchStartedAt:start,lastAmazonProgressAt:now-601000,
 amazonPaginationState:{runId:'run-exact',stageStartedAt:start-30000,account:'a@example.com',parserTabId:9,accountSwitchStartedAt:start,parseId:'parse-old',currentPage:14,totalPages:20,navigation:null,allOrders:[{order_id:'old-partial',qty:2}],cancelledOrders:[{orderId:'cancel-old'}]},
 amazonOrders:[{order_id:'old-partial',qty:2}],amazonCancelledOrders:[{orderId:'cancel-old'}],
 orderData:{Amazon:{orders:[{order_id:'other-cabinet'}]}},trackScreenshotQueue:[],screenshotArchiveLedger:{entries:{prior:{state:'delivered'}}},sentScreenshots:{track:true},
 amazonParsingComplete:null,amazonTimeoutAttempt:null,amazonStageFinalizing:null,
 };}
function harness(data=initial(),hooks={}){
 const calls=[],tabs=new Map(),clock={now};const context={URL,TextEncoder,structuredClone,Date:class extends Date{static now(){return clock.now}},console:{log(){},warn(x){calls.push(['log',x])}},
 AMAZON_ACCOUNT_HARD_CAP_MS:2700000, trackScreenshotQueue:[],isProcessingScreenshots:false,
 chrome:{storage:{local:{async get(keys){await hooks.get?.(keys,data);if(typeof keys==='string')keys=[keys];return Object.fromEntries(keys.filter(k=>k in data).map(k=>[k,clone(data[k])]))},async set(patch){await hooks.set?.(patch,data);calls.push(['set',clone(patch)]);Object.assign(data,clone(patch))},async remove(keys){for(const k of keys)delete data[k]}}},
 tabs:{async get(id){calls.push(['getTab',id]);if(hooks.tabGet)return hooks.tabGet(id,tabs,data);if(!tabs.has(id))throw Error('No tab with id: '+id+'.');return clone(tabs.get(id))},
 async create(opts){calls.push(['create',clone(opts)]);await hooks.create?.(data);const t={id:18+calls.filter(c=>c[0]==='create').length,url:opts.url};tabs.set(t.id,t);return clone(t)},
 async update(id,opts){calls.push(['update',id,clone(opts)]);await hooks.update?.(data);tabs.set(id,{id,url:opts.url});return clone(tabs.get(id))},async remove(id){calls.push(['remove',id]);await hooks.remove?.(id,tabs,data);tabs.delete(id)}}}};
 vm.createContext(context); installParserComponentAdmission(context);vm.runInContext('let amazonAttemptMutationChain=Promise.resolve();let parserOperationFlights=new Map();',context);
 for(const name of ['normalizeAccountEmail','pipelineRunAccountIsTerminal','pipelineGenerationFromStage','pipelineGenerationMatches','pipelineOperationKey','runParserOperationSingleFlight','amazonWatchdogAttemptFromState','amazonWatchdogAttemptIdentityMatches','amazonWatchdogAttemptMatches','withAmazonAttemptMutation','amazonPaginationPayloadMatchesAttempt','amazonAttemptRefMatchesRuntime','amazonAttemptRefFromPayload','isSafeAmazonOrdersUrl','handleAmazonAttemptCommit','resumePreparedPipelineStageAfterRestart','getAmazonParserTab','readAmazonTimeoutTabEvidence','getAmazonSwitchAccountUrl','dispatchCurrentAmazonAccountSwitch','dispatchCurrentAmazonAccountSwitchOnce'])vm.runInContext(fn(name),context);
 const start=source.indexOf('const AMAZON_MISSING_TAB_SNAPSHOT_CAP =');const end=source.indexOf('async function getAmazonParserTab(',start);vm.runInContext(source.slice(start,end),context);
 return {context,data,calls,tabs,clock,recover:()=>context.recoverAmazonMissingTab(clone(data)),dispatch:()=>context.dispatchCurrentAmazonAccountSwitch(data.multiAccountState.currentAmazonAccount,context.pipelineGenerationFromStage(data.pipelineStage),'account-switch')};
}
const count=(h,type)=>h.calls.filter(c=>c[0]===type).length;
const marker=h=>h.data.amazonMissingTabRecoveries.attempts[0];

test('actual missing tab with navigation null: snapshot before one create; same cabinet/page1 and no ACK/data reset',async()=>{
 const h=harness(),before=clone(h.data),result=await h.recover();assert.equal(result.status,'recovered');assert.equal(count(h,'create'),1);assert.equal(count(h,'update'),1);
 assert.equal(marker(h).phase,'dispatched');assert.deepEqual(marker(h).snapshot.pagination,before.amazonPaginationState);assert.deepEqual(marker(h).snapshot.amazonOrders,before.amazonOrders);
 assert.equal(marker(h).snapshotBytes,new TextEncoder().encode(JSON.stringify(marker(h).snapshot)).length);
 assert.equal(h.data.amazonPaginationState,null);assert.equal(h.data.amazonParserTabId,19);assert.equal(h.data.accountSwitchStartedAt,before.accountSwitchStartedAt);
 for(const k of ['orderData','amazonOrders','amazonCancelledOrders','sentScreenshots','screenshotArchiveLedger','trackScreenshotQueue','multiAccountState'])assert.deepEqual(h.data[k],before[k],k);
 assert.equal(h.calls.find(c=>c[0]==='update')[2].url,h.context.getAmazonSwitchAccountUrl());
 const createAt=h.calls.findIndex(c=>c[0]==='create');const intentAt=h.calls.findIndex(c=>c[1]?.amazonMissingTabRecoveries?.attempts[0].phase==='creating');assert.ok(intentAt>=0&&intentAt<createAt);
 const attempt=h.context.amazonWatchdogAttemptFromState(before);assert.equal(h.context.amazonAttemptRefMatchesRuntime(attempt,h.data,9).reason,'parser-tab-changed');
 assert.match(content,/if \(!state\) \{[\s\S]*?parseId:[\s\S]*?currentPage: 1/);
});

test('concurrent watchdog calls share one actual recovery and one dispatch',async()=>{
 const h=harness();const results=await Promise.all([h.recover(),h.recover()]);assert.deepEqual(results.map(x=>x.status),['recovered','recovered']);assert.equal(count(h,'create'),1);assert.equal(count(h,'update'),1);
 assert.equal((await h.recover()).status,'exhausted');assert.equal(count(h,'create'),1);
});

test('only two exact not-found reads permit recovery; timeout/live signin/unassigned stop',async()=>{
 for(const mode of ['timeout','live','second-live','unassigned']){
 let gets=0;const data=initial();if(mode==='unassigned')data.amazonParserTabId=null;
 const h=harness(data,{tabGet:async id=>{gets++;if(mode==='timeout')throw Error('CDP timeout');if(mode==='live'||mode==='second-live'&&gets===2)return{id,url:'https://www.amazon.com/ap/signin'};throw Error('No tab with id: '+id)}});
 const r=await h.recover();assert.notEqual(r.status,'recovered',mode);assert.equal(count(h,'create'),0);assert.equal(count(h,'set'),0);
 }
});

test('terminal/completed/timeout/wrong-generation and expired absolute budget cannot create or suppress normal timeout',async()=>{
 for(const change of [d=>{d.pipelineRun.status='degraded'},d=>{d.pipelineRun.completed.amazon.push('a@example.com')},d=>{d.amazonParsingComplete={timestamp:now}},d=>{d.amazonTimeoutAttempt={phase:'resolving'}},d=>{d.accountSwitchStartedAt=now-2700000},d=>{d.amazonPaginationState.runId='foreign'}]){
 const data=initial();change(data);const h=harness(data);const r=await h.recover();assert.notEqual(r.status,'recovered');assert.notEqual(r.status,'stale');assert.equal(count(h,'create'),0);assert.equal(count(h,'set'),0);
 }
});

test('completion or generation change between exact missing reads wins without mutation',async()=>{
 for(const change of [d=>{d.amazonParsingComplete={timestamp:now}},d=>{d.pipelineStage.stageStartedAt++}]){
 let n=0;const h=harness(initial(),{tabGet:async(id,t,d)=>{if(++n===1)change(d);throw Error('No tab with id: '+id)}});await h.recover();assert.equal(count(h,'set'),0);assert.equal(count(h,'create'),0);
 }
});

test('snapshot cap, storage refusal and active screenshots preserve partial data and do not create',async()=>{
 for(const mode of ['cap','write','queue','memory','processing','marker','budget']){
 const data=initial();if(mode==='cap')data.amazonPaginationState.allOrders=[{text:'x'.repeat(4*1024*1024)}];if(mode==='queue')data.trackScreenshotQueue=[{}];if(mode==='marker')data.parserScreenshotReuseTab={tabId:9};if(mode==='budget')data.screenshotStageBudget={activeSince:now};
 const before=clone(data.amazonPaginationState),h=harness(data,{set:async()=>{if(mode==='write')throw Error('QUOTA_BYTES')}});if(mode==='memory')h.context.trackScreenshotQueue.push({});if(mode==='processing')h.context.isProcessingScreenshots=true;
 assert.notEqual((await h.recover()).status,'recovered');assert.equal(count(h,'create'),0);assert.deepEqual(data.amazonPaginationState,before);
 }
});

test('uncertain tab create survives fresh worker and never creates a replacement again',async()=>{
 const h=harness(initial(),{create:async()=>{throw Error('lost create reply')}});assert.equal((await h.recover()).status,'uncertain');assert.equal(marker(h).phase,'creating');
 const restart=harness(h.data);assert.equal(await restart.dispatch(),false);assert.equal(count(restart,'create'),0);assert.equal(count(restart,'update'),0);
});

test('failure saving returned tab id retains creating fence; startup cannot create another',async()=>{
 const h=harness(initial(),{set:async p=>{if(p.amazonMissingTabRecoveries?.attempts[0].phase==='prepared')throw Error('disk failure')}});assert.equal((await h.recover()).status,'uncertain');assert.equal(count(h,'create'),1);assert.equal(marker(h).phase,'creating');
 const restart=harness(h.data);assert.equal(await restart.dispatch(),false);assert.equal(count(restart,'create'),0);
});

test('prepared exact blank tab can resume once after worker restart; foreign URL/missing id refuse',async()=>{
 const h=harness(initial(),{set:async p=>{if(p.amazonMissingTabRecoveries?.attempts[0].phase==='navigating')throw Error('worker stopped')}});await h.recover();assert.equal(marker(h).phase,'prepared');
 for(const mode of ['blank','signin','missing']){
 const r=harness(clone(h.data));if(mode!=='missing')r.tabs.set(19,{id:19,url:mode==='blank'?'about:blank':'https://www.amazon.com/ap/signin'});
 assert.equal(await r.dispatch(),mode==='blank');assert.equal(count(r,'create'),0);assert.equal(count(r,'update'),mode==='blank'?1:0);
 }
});

test('navigation uncertain is fenced across worker restart without navigation or create retry',async()=>{
 const h=harness(initial(),{update:async()=>{throw Error('unknown navigation ACK')}});assert.equal((await h.recover()).status,'uncertain');assert.equal(marker(h).phase,'navigating');
 const r=harness(h.data);r.tabs.set(19,{id:19,url:'about:blank'});assert.equal(await r.dispatch(),false);assert.equal(count(r,'create'),0);assert.equal(count(r,'update'),0);
});

test('ordinary account dispatcher remains unchanged without recovery and no foreign tab adoption exists',async()=>{
 const d=initial();d.pendingAccountSwitch={email:'a@example.com',runId:d.pipelineRun.id};const h=harness(d);assert.equal(await h.dispatch(),true);assert.equal(count(h,'create'),1);assert.equal(count(h,'update'),1);
 assert.doesNotMatch(fn('dispatchAmazonMissingTabRecovery'),/tabs\.query|executeScript|sendMessage/);
});

test('watchdog integration preserves the original absolute budget and performs recovery before timeout claim',()=>{
 const start=source.indexOf('if (!hasMatchingCompletion && stored.accountSwitchStartedAt');const s=source.slice(start,source.indexOf('const failedEmail',start));
 assert.ok(s.indexOf('recoverAmazonMissingTab(stored)')<s.indexOf('claimAmazonTimeoutAttempt(timeoutAttempt)'));
 assert.match(s,/graceUntil: amazonMissingTabRecord\(stored\) \? null/);
 assert.doesNotMatch(fn('dispatchAmazonMissingTabRecovery'),/accountSwitchStartedAt:\s*(?:Date|now)|switchToNextAmazonAccount|startMultiAccountAmazonParsing/);
});


test('actual startup dispatch cannot repeat a consumed create permit, and resumes a known prepared tab',async()=>{
 for(const phase of ['creating','prepared']){
 const h=harness(initial(),phase==='creating'?{create:async()=>{throw Error('lost ACK')}}:{set:async p=>{if(p.amazonMissingTabRecoveries?.attempts[0].phase==='navigating')throw Error('worker stopped')}});
 await h.recover();assert.equal(marker(h).phase,phase);const r=harness(clone(h.data));if(phase==='prepared')r.tabs.set(19,{id:19,url:'about:blank'});
 assert.equal(await r.context.resumePreparedPipelineStageAfterRestart(),phase==='prepared');assert.equal(count(r,'create'),0);assert.equal(count(r,'update'),phase==='prepared'?1:0);
 }
});

test('actual new cursor and final commit retain original partial proof, prior cabinet rows and durable ACKs',async()=>{
 const h=harness(),old=clone(h.data);await h.recover();const attempt={...h.context.amazonWatchdogAttemptFromState(h.data),parseId:'parse-new'};
 const page={...old.amazonPaginationState,...attempt,currentPage:1,allOrders:[],cancelledOrders:[]};
 const r=await h.context.handleAmazonAttemptCommit({kind:'cursor',attempt,paginationState:page,amazonOrders:[]},19);assert.equal(r.ok,true);assert.equal(h.data.amazonPaginationState.currentPage,1);
 assert.equal((await h.context.handleAmazonAttemptCommit({kind:'cursor',attempt:h.context.amazonWatchdogAttemptFromState(old),paginationState:old.amazonPaginationState},9)).ok,false);
 const done=await h.context.handleAmazonAttemptCommit({kind:'complete',attempt,paginationState:{...page,currentPage:21},orders:[{order_id:'new-complete',qty:1}],cancelledOrders:[],reason:'configured-limit'},19);
 assert.equal(done.ok,true);assert.equal(h.data.amazonParsingComplete.parseId,'parse-new');assert.deepEqual(h.data.orderData.Amazon.orders.map(x=>x.order_id),['new-complete','other-cabinet']);
 assert.deepEqual(marker(h).snapshot.pagination,old.amazonPaginationState);assert.deepEqual(h.data.sentScreenshots,old.sentScreenshots);assert.deepEqual(h.data.screenshotArchiveLedger,old.screenshotArchiveLedger);
});

test('completion committed before recovery wins through actual commit arbiter',async()=>{
 const h=harness(),attempt=h.context.amazonWatchdogAttemptFromState(h.data),page=clone(h.data.amazonPaginationState);
 const done=h.context.handleAmazonAttemptCommit({kind:'complete',attempt,paginationState:page,orders:[],cancelledOrders:[],reason:'explicit-end'},9);
 const recovery=h.recover();assert.equal((await done).ok,true);assert.notEqual((await recovery).status,'recovered');assert.equal(count(h,'create'),0);
});

test('deadline crossed while persisting create or navigation intent permits no late browser mutation',async()=>{
 for(const phase of ['creating','navigating']){
 let h;h=harness(initial(),{set:async p=>{if(p.amazonMissingTabRecoveries?.attempts[0].phase===phase)h.clock.now=h.data.accountSwitchStartedAt+2700000}});
 assert.notEqual((await h.recover()).status,'recovered');assert.equal(count(h,'create'),phase==='creating'?0:1);assert.equal(count(h,'update'),0);
 }
});

test('changed generation closes only our just-created still-blank tab once; unknown or navigated tab is retained',async()=>{
 for(const mode of ['blank','foreign','read-failed','close-failed']){
 const h=harness(initial(),{create:async d=>{d.pipelineStage.stageStartedAt++},tabGet:async(id,tabs)=>{
  if(!tabs.has(id))throw Error('No tab with id: '+id);if(mode==='read-failed')throw Error('unreadable');return {...tabs.get(id),url:mode==='foreign'?'https://www.amazon.com/cart':'about:blank'};
 },remove:async()=>{if(mode==='close-failed')throw Error('HTTP close failed')}});
 assert.notEqual((await h.recover()).status,'recovered');assert.equal(count(h,'create'),1);assert.equal(count(h,'update'),0);
 assert.equal(count(h,'remove'),['blank','close-failed'].includes(mode)?1:0);assert.equal(marker(h).cleanup.tabId,19);
 assert.equal(marker(h).cleanup.status,mode==='blank'?'closed':mode==='foreign'?'navigated':'unknown');assert.equal(marker(h).phase,mode==='blank'?'aborted':'creating');
 }
});

test('unknown create also blocks final-return creation; malformed persisted proof cannot grant another permit',async()=>{
 const h=harness(initial(),{create:async()=>{throw Error('lost ACK')}});await h.recover();const d=clone(h.data),g=h.context.pipelineGenerationFromStage(d.pipelineStage);
 d.amazonStageFinalizing={...g,account:'a@example.com'};const r=harness(d);assert.equal(await r.context.dispatchCurrentAmazonAccountSwitch('a@example.com',g,'final-return'),false);assert.equal(count(r,'create'),0);
 for(const change of [m=>{m.snapshotBytes++},m=>{m.phase='anything'},m=>{m.attempt.parserTabId=null},m=>{m.snapshot.pagination.runId='foreign'}]){
 const data=clone(h.data);change(data.amazonMissingTabRecoveries.attempts[0]);const restarted=harness(data);await assert.rejects(restarted.dispatch(),/LEDGER_INVALID/);assert.equal(count(restarted,'create'),0);assert.equal(count(restarted,'update'),0);
 }
});


test('ordinary final-return reuses exact known prepared blank after exhausted recovery instead of making a second tab',async()=>{
 const h=harness(initial(),{set:async p=>{if(p.amazonMissingTabRecoveries?.attempts[0].phase==='navigating')throw Error('worker stopped')}});await h.recover();assert.equal(marker(h).phase,'prepared');
 const d=clone(h.data),g=h.context.pipelineGenerationFromStage(d.pipelineStage);d.amazonStageFinalizing={...g,account:'a@example.com'};
 for(const mode of ['blank','foreign','read-failed']){
 const r=harness(clone(d),mode==='read-failed'?{tabGet:async()=>{throw Error('read failed')}}:{});r.tabs.set(19,{id:19,url:mode==='foreign'?'https://www.amazon.com/cart':'about:blank'});
 assert.equal(await r.context.dispatchCurrentAmazonAccountSwitch('a@example.com',g,'final-return'),mode==='blank');assert.equal(count(r,'create'),0);assert.equal(count(r,'update'),mode==='blank'?1:0);
 }
});

test('fence is exact-cabinet scoped: a later cabinet has its own single attempt, retaining the first snapshot',async()=>{
 const h=harness();await h.recover();const first=clone(marker(h));
 const start=now-600000;h.data.multiAccountState.currentAmazonAccount='b@example.com';h.data.accountSwitchStartedAt=start;
 h.data.amazonPaginationState={...clone(first.snapshot.pagination),account:'b@example.com',accountSwitchStartedAt:start,parserTabId:19,parseId:'parse-b'};
 h.tabs.delete(19);assert.equal((await h.recover()).status,'recovered');assert.equal(count(h,'create'),2);
 assert.equal(h.data.amazonMissingTabRecoveries.attempts.length,2);assert.deepEqual(h.data.amazonMissingTabRecoveries.attempts[0],first);assert.equal(h.data.amazonMissingTabRecoveries.attempts[1].attempt.account,'b@example.com');
});


test('recovery requires the exact Chrome missing-ID error, not a substring or a different missing tab',async()=>{
 for(const error of ['No tab with id: 99.','CDP timeout: No tab with id: 9.','No tab with id: 9. permission denied','No tab with id','Tab not found']){
  const h=harness(initial(),{tabGet:async()=>{throw Error(error)}});assert.notEqual((await h.recover()).status,'recovered');assert.equal(count(h,'set'),0);assert.equal(count(h,'create'),0);
 }
});

test('recovery requires the immutable run roster and active multi-account mode before any write',async()=>{
 for(const change of [d=>{d.pipelineRun.expected.amazon=['other@example.com']},d=>{delete d.pipelineRun.expected},d=>{d.multiAccountState.isMultiAccountParsing=false},d=>{delete d.multiAccountState.isMultiAccountParsing}]){
  const data=initial();change(data);const h=harness(data);assert.notEqual((await h.recover()).status,'recovered');assert.equal(count(h,'set'),0);assert.equal(count(h,'create'),0);assert.equal(count(h,'update'),0);
 }
});

test('account ownership lost while saving create intent prevents browser mutation',async()=>{
 for(const change of [d=>{d.pipelineRun.expected.amazon=['other@example.com']},d=>{d.multiAccountState.isMultiAccountParsing=false}]){
  const h=harness(initial(),{set:async(p,d)=>{if(p.amazonMissingTabRecoveries?.attempts[0].phase==='creating')change(d)}});
  assert.notEqual((await h.recover()).status,'recovered');assert.equal(count(h,'create'),0);assert.equal(count(h,'update'),0);
 }
});
