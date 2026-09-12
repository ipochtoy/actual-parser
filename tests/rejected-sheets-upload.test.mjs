import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8');
const take=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const protocol=take('// BEGIN REJECTED SHEETS UPLOAD ARCHIVE','// END REJECTED SHEETS UPLOAD ARCHIVE');
const upload=take('async function uploadToSheets(','async function triggerPochtoyAutoStart(');
const flight=take('function getOrStartFinalSheetsUpload(','// Приём внешних команд');
const RUN='1788750000000-1788747903264-w0ec7e';
const started=Date.parse('2026-09-07T02:25:03.314Z'),finished=Date.parse('2026-09-07T03:08:49.270Z');
const archiveKey=`parserRejectedUploadArchive:${RUN}`;
function harness(options={}) {
 const item={store_name:'Amazon',order_id:'111-8440692-1955402',track_number:'TBA334181350127',product_name:'Cruel Paradise (Beautifully Cruel)',qty:null,color:'',size:'',account_name:'ipochtoy@gmail.com',composition_parsed:false,composition_reason:'empty-qty',parser_run_id:RUN,parser_account:'ipochtoy@gmail.com',observed_at:'2026-09-07T02:48:30.172Z'};
 const run={id:RUN,status:'degraded',source:'coordinator-control',slotAt:Date.parse('2026-09-07T03:00:00Z'),attemptedAt:started-50,startedAt:started,finishedAt:finished,nightSlotDay:'2026-09-06',nightRequestToken:'night:2026-09-06:fixture-request',expected:{amazon:['ipochtoy@gmail.com']},completed:{amazon:['ipochtoy@gmail.com']},failures:[{shop:'amazon',account:'missing@example.com'}]};
 const state={spreadsheetId:'fixture',sheetName:'Лист1',pipelineRun:run,pipelineStage:{active:false,runId:RUN,stages:['iherb','ebay','amazon','done'],stageName:'done',currentIndex:3},parsingState:{isParsingAllStores:false},pendingSheetsUpload:{runId:RUN,forSlot:run.slotAt,savedAt:finished+1},trackScreenshotQueue:[],orderData:{Amazon:{orders:[item,...Array.from({length:1246},(_,i)=>({...item,order_id:`historical-${i}`,qty:1,composition_parsed:true}))]}},amazonPaginationState:{allOrders:[{...item,order_id:'partial-cabinet'}]},screenshotArchiveLedger:{schemaVersion:1,entries:{one:{state:'delivered',archive:{link:'https://t.me/c/3888176404/36540',messageId:36540}}}},sentScreenshots:['known-ack-key'],telegramToken:'NEVER_ARCHIVE_THIS'};
 state.nightCabinetLease={owner:'parser',phase:'running',runId:RUN,token:run.nightRequestToken,slotId:String(run.slotAt)};
 const copies=options.copies || [1,1,1,1,''].map(q=>['Amazon',item.order_id,item.track_number,item.product_name,String(q),'','','existing-archive','ipochtoy@gmail.com','','']);
 const h={state,writes:[],post:0,append:0,success:0,reads:0};
 const ctx={Date:class extends Date{static now(){return options.now ?? finished+60000}},TextEncoder,crypto:webcrypto,structuredClone,Uint8Array,URL,console:{log(){},error(){},warn(){}},DEFAULT_SPREADSHEET_ID:'fixture',parseReport:{},nightCabinetSlotDay:()=>run.nightSlotDay,normalizeAccountEmail:x=>String(x||'').trim().toLowerCase(),async uploadLogsToSheet(){throw new Error('must not upload logs after rejection')},async replayScreenshotLinks(){},async sendTelegramMessage(){},async getAuthToken(){if(options.authError)throw options.authError;return 'fake'},async readSheetData(){if(options.readError)throw options.readError;return structuredClone(copies)},async fetch(){h.post++;throw options.postError||new Error('unexpected POST')},async writeDataToSheet(){h.append++;},chrome:{runtime:{sendMessage(x){if(x.status==='success')h.success++}},storage:{local:{async get(keys){assert.notEqual(keys,null);h.reads++;options.beforeGet?.(h,keys);const out={};for(const k of Array.isArray(keys)?keys:[keys])if(k in state)out[k]=structuredClone(state[k]);return out},async set(patch){options.beforeSet?.(h,patch);h.writes.push(structuredClone(patch));Object.assign(state,structuredClone(patch));options.afterSet?.(h,patch)}}}}};
 vm.createContext(ctx);vm.runInContext(`let finalSheetsUploadInFlight=null;let isParsingAllStores=false;let isProcessingScreenshots=false;\n${protocol}\n${flight}\n${upload}`,ctx);
 h.ctx=ctx;h.run=()=>ctx.getOrStartFinalSheetsUpload(RUN).promise;return h;
}

for (const repeated of [false,true]) test(`actual ${repeated?'repeated':'single'} variant preflight refusal archives whole data and remains a failure`,async()=>{
 const copy=['Amazon','111-8440692-1955402','TBA334181350127','Cruel Paradise (Beautifully Cruel)','','','XL','existing-archive','ipochtoy@gmail.com','',''];
 const h=harness({copies:repeated?[copy,copy]:[copy]});
 if(repeated)h.state.orderData.Amazon.orders.push(structuredClone(h.state.orderData.Amazon.orders[0]));
 const before=structuredClone(h.state);
 await assert.rejects(h.run(),e=>e.code==='PARSER_SHEETS_VARIANT_CONFLICT'&&e.rejectedUploadArchived===true);
 assert.equal(h.post+h.append+h.success,0);assert.equal(h.state.pendingSheetsUpload,null);
 assert.deepEqual(h.state.pipelineRun,before.pipelineRun);assert.deepEqual(h.state.orderData,before.orderData);
 const archived=JSON.parse(h.state[archiveKey].json);assert.equal(archived.code,'PARSER_SHEETS_VARIANT_CONFLICT');
 assert.deepEqual(archived.snapshot.orderData,before.orderData);assert.deepEqual(archived.snapshot.sentScreenshots,before.sentScreenshots);
 assert.equal((await h.ctx.readParserRejectedUploadProof()).archiveVerified,true);assert.equal(h.state.lastSheetsUploadRunId,undefined);
});

test('unbranded variant errors and modified failure kind cannot grant a handoff',async()=>{
 const h=harness();assert.equal(await h.ctx.archiveRejectedSheetsUpload(RUN,Object.assign(Error('Ambiguous variant in existing Sheets item'),{code:'PARSER_SHEETS_VARIANT_CONFLICT'})),false);
 await assert.rejects(h.run());h.state.parserRejectedUpload.code='PARSER_SHEETS_VARIANT_CONFLICT';
 assert.equal(await h.ctx.readParserRejectedUploadProof(),null);
});

test('actual prewrite refusal seals all1247 raw rows/intermediate/ACK, releases only pending, restart verifies archive',async()=>{
 const h=harness(),before=structuredClone(h.state);await assert.rejects(h.run(),e=>e.code==='PARSER_SHEETS_QTY_CONFLICT'&&e.rejectedUploadArchived===true);
 assert.equal(h.post+h.append+h.success,0);assert.equal(h.state.pendingSheetsUpload,null);
 assert.deepEqual(h.state.pipelineRun,before.pipelineRun);assert.deepEqual(h.state.orderData,before.orderData);assert.deepEqual(h.state.sentScreenshots,before.sentScreenshots);
 const saved=h.state[archiveKey],payload=JSON.parse(saved.json),receipt=h.state.parserRejectedUpload;
 assert.equal(payload.rawRows,1247);assert.deepEqual(payload.snapshot.orderData,before.orderData);assert.deepEqual(payload.snapshot.amazonPaginationState,before.amazonPaginationState);assert.deepEqual(payload.snapshot.screenshotArchiveLedger,before.screenshotArchiveLedger);
 assert.equal(saved.json.includes('NEVER_ARCHIVE_THIS'),false);assert.equal(receipt.sha256,createHash('sha256').update(saved.json).digest('hex'));assert.equal(receipt.bytes,Buffer.byteLength(saved.json));
 for(const k of ['lastSheetsUploadOkAt','lastSheetsUploadRunId','lastSuccessfulDailyRunAt'])assert.equal(h.state[k],undefined);
 assert.equal((await h.ctx.readParserRejectedUploadProof()).archiveVerified,true);
 const restarted=harness();Object.assign(restarted.state,structuredClone(h.state));assert.equal((await restarted.ctx.readParserRejectedUploadProof()).runId,RUN);
 await assert.rejects(restarted.run(),/no matching durable pending/);assert.equal(restarted.post,0);
});
for(const [name,options] of [
 ['quota failure',{beforeSet(h,p){if(p[archiveKey])throw new Error('QUOTA_BYTES quota exceeded')}}],
 ['readback corruption',{afterSet(h,p){if(p[archiveKey])h.state[archiveKey].json+='corrupt'}}],
 ['raw generation race',{afterSet(h,p){if(p[archiveKey])h.state.pipelineRun.id='foreign'}}],
 ['raw data race',{afterSet(h,p){if(p[archiveKey])h.state.orderData.Amazon.orders[0].qty=42}}],
 ['ACK race',{afterSet(h,p){if(p[archiveKey])h.state.sentScreenshots.push('concurrent')}}],
 ['forged network type',{readError:Object.assign(new Error('network'),{code:'PARSER_SHEETS_QTY_CONFLICT'})}],
 ['OAuth',{authError:new Error('OAuth unavailable')}],
])test(`${name} cannot release pending or claim Sheets success`,async()=>{
 const h=harness(options);if(options.authError)for(const row of h.state.orderData.Amazon.orders){row.qty=2;row.composition_parsed=true}await assert.rejects(h.run());assert.equal(h.state.pendingSheetsUpload?.runId,RUN);assert.equal(h.state.parserRejectedUpload,undefined);assert.equal(h.success,0);
});
test('whole byte cap refuses without truncating/writing archive',async()=>{const h=harness();h.state.amazonPaginationState.large='x'.repeat(16*1024*1024);await assert.rejects(h.run(),/whole-data limit/);assert.equal(h.state.pendingSheetsUpload.runId,RUN);assert.equal(h.state[archiveKey],undefined)});
test('existing unequal immutable archive is never overwritten',async()=>{const h=harness();h.state[archiveKey]={schema:1,json:'old'};await assert.rejects(h.run(),/already differs/);assert.equal(h.state[archiveKey].json,'old');assert.equal(h.state.pendingSheetsUpload.runId,RUN)});
test('matching error message without actual brand cannot archive',async()=>{const h=harness();const result=await h.ctx.archiveRejectedSheetsUpload(RUN,Object.assign(new Error('Conflicting Sheets quantities require a complete exact Parser item'),{code:'PARSER_SHEETS_QTY_CONFLICT'}));assert.equal(result,false);assert.equal(h.writes.length,0)});
test('post-write uncertainty stays pending and receives no rejected outcome',async()=>{const h=harness();for(const item of h.state.orderData.Amazon.orders){item.qty=2;item.composition_parsed=true}await assert.rejects(h.run(),/unexpected POST/);assert.equal(h.post,1);assert.equal(h.state.pendingSheetsUpload.runId,RUN);assert.equal(h.state.parserRejectedUpload,undefined)});
for(const field of ['sha256','runId','requestToken','archiveKey','rawRows'])test(`receipt ${field} corruption stops handoff`,async()=>{const h=harness();await assert.rejects(h.run());h.state.parserRejectedUpload[field]='foreign';assert.equal(await h.ctx.readParserRejectedUploadProof(),null)});
test('active queue and changed raw after rejection cannot authorize handoff',async()=>{for(const mutate of [h=>h.state.trackScreenshotQueue.push({track:'late'}),h=>h.state.orderData.Amazon.orders.pop(),h=>h.state.pipelineStage.active=true]){const h=harness();await assert.rejects(h.run());mutate(h);assert.equal(await h.ctx.readParserRejectedUploadProof(),null)}});

for(const [name,mutate] of [
 ['parser volatile',h=>vm.runInContext('isParsingAllStores=true',h.ctx)],
 ['screenshot volatile',h=>vm.runInContext('isProcessingScreenshots=true',h.ctx)],
 ['reuse tab',h=>h.state.parserScreenshotReuseTab={tabId:1}],
 ['local tab',h=>h.state.parserScreenshotLocalTab={tabId:2}],
 ['active budget',h=>h.state.screenshotStageBudget={activeSince:1}],
 ['foreign lease',h=>h.state.nightCabinetLease.token='foreign'],
])test(`${name} blocks archiving and release`,async()=>{const h=harness();mutate(h);await assert.rejects(h.run());assert.equal(h.state.pendingSheetsUpload.runId,RUN);assert.equal(h.state.parserRejectedUpload,undefined)});
if(process.env.PARSER_REJECTED_UPLOAD_FORENSIC_FIXTURE)test('private exact degraded1247 forensic state is preserved whole with its real diagnostics',async()=>{
 const file=fs.readFileSync(process.env.PARSER_REJECTED_UPLOAD_FORENSIC_FIXTURE);
 assert.equal(createHash('sha256').update(file).digest('hex'),process.env.PARSER_REJECTED_UPLOAD_FORENSIC_SHA);
 const forensic=JSON.parse(file);const h=harness();Object.assign(h.state,structuredClone(forensic.state));
 const before=structuredClone(h.state);await assert.rejects(h.run(),e=>e.rejectedUploadArchived===true);
 const data=JSON.parse(h.state[archiveKey].json);assert.equal(data.rawRows,1247);
 for(const key of ['orderData','amazonMultiAccountLog','amazonTimeoutAttempt','parsingLogs','nightCabinetLease','lastDailyAutoParseStatus'])assert.deepEqual(data.snapshot[key],before[key]??null);
});

test('sealed archive resumes after a transient guard failure and diagnostic drift without overwriting it',async()=>{
 let first=true;const h=harness({afterSet(h,p){if(p[archiveKey]&&first){first=false;h.state.parserScreenshotLocalTab={tabId:7}}}});
 h.state.parsingLogs=['original'];await assert.rejects(h.run(),/source changed after archive/);const saved=structuredClone(h.state[archiveKey]);
 assert.equal(h.state.pendingSheetsUpload.runId,RUN);delete h.state.parserScreenshotLocalTab;h.state.parsingLogs=['new diagnostic'];h.state.lastDailyAutoParseStatus='blocked-pending-sheets';
 await assert.rejects(h.run(),e=>e.rejectedUploadArchived===true);assert.deepEqual(h.state[archiveKey],saved);assert.deepEqual(JSON.parse(saved.json).snapshot.parsingLogs,['original']);
 assert.equal((await h.ctx.readParserRejectedUploadProof()).archiveVerified,true);h.state.parsingLogs.push('later alarm');assert.equal((await h.ctx.readParserRejectedUploadProof()).archiveVerified,true);
});
test('row count cap refuses without silently truncating raw rows',async()=>{const h=harness();h.state.orderData.Amazon.orders=Array.from({length:20001},(_,i)=>({...h.state.orderData.Amazon.orders[i?1:0],order_id:i?`count-${i}`:h.state.orderData.Amazon.orders[0].order_id}));await assert.rejects(h.run(),/row count/);assert.equal(h.state.pendingSheetsUpload.runId,RUN);assert.equal(h.state[archiveKey],undefined)});
function installCanonicalDoor(h) {
 const {ctx}=h,now=ctx.Date.now();
 ctx.STANDALONE_WALK_LEDGER_KEY='standaloneWalkGenerationLedger';
 Object.assign(ctx,{NIGHT_CABINET_AUTHORITY_SCOPE_KEY:'nightCabinetAuthorityScope',
  NIGHT_CABINET_CLEANUP_KEY:'nightCabinetCleanupLease',NIGHT_CABINET_CLEANUP_LEDGER_KEY:'nightCabinetCleanupLedger'});
 Object.assign(ctx,{nightCabinetLeaseWriteChain:Promise.resolve(),NIGHT_CABINET_LEASE_KEY:'nightCabinetLease',NIGHT_CABINET_LEASE_TTL_MS:900000,NIGHT_CABINET_TIME_ZONE:'America/New_York',NIGHT_CABINET_OWNERS:new Set(['store-walk','parser']),NIGHT_CABINET_PHASES:new Set(['running','ready','store-catchup','store-main','completed','degraded']),NIGHT_CABINET_TRANSITION_REQUEST_KEY:'nightCoordinatorLeaseTransitionRequest',NIGHT_CABINET_TRANSITION_RESULT_KEY:'nightCoordinatorLeaseTransitionResult',NIGHT_CABINET_TRANSITION_HANDLED_KEY:'lastHandledNightCoordinatorLeaseTransitionId',NIGHT_CABINET_CATCHUP_RESUME_KEY:'nightCabinetCatchupResumeMarkers',nightCabinetLeaseSlotIds:()=>[String(h.state.pipelineRun.slotAt)]});
 h.state.nightCabinetLease={...h.state.nightCabinetLease,heartbeat:now-1,expires:now+900000};
 vm.runInContext([
  take('function inspectNightCabinetLease(','function nightCabinetTerminalSlotProof('),
  take('function nightCabinetTerminalSlotProof(','async function scheduleNightCabinetRetry('),
  take('async function handleNightCoordinatorLeaseTransitionRequest(','async function handleNightCoordinatorLeaseTransitionWake('),
  fullFunction('prepareParserNightCabinetLease'),
  fullFunction('externalCoordinatorStartDecision'),
 ].join('\n'),ctx);
}
test('actual canonical handoff consumes failed proof, then exact ready retry revalidates unchanged archive without old owner fiction',async()=>{
 const h=harness();installCanonicalDoor(h);await assert.rejects(h.run(),e=>e.rejectedUploadArchived===true);
 const lease=h.state.nightCabinetLease,nextToken=`${lease.token}:attempt-2`;
 h.state.nightCoordinatorLeaseTransitionRequest={requestId:'failure-retry-fixture',requestedAt:finished+60000,expected:{state:'present',slotId:lease.slotId,owner:lease.owner,phase:lease.phase,token:lease.token,runId:RUN},desired:{slotId:lease.slotId,owner:'parser',phase:'ready',token:nextToken}};
 const result=await h.ctx.handleNightCoordinatorLeaseTransitionRequest();assert.equal(result.ok,true);assert.equal(h.state.nightCabinetLease.phase,'ready');assert.equal(h.state.nightCabinetLease.token,nextToken);
 assert.equal(await h.ctx.readParserRejectedUploadProof(),null,'default proof cannot claim the old owner after handoff');
 assert.equal((await h.ctx.readParserRejectedUploadProof({readyRetryToken:nextToken})).archiveVerified,true);
 assert.equal(await h.ctx.readParserRejectedUploadProof({readyRetryToken:'foreign-token-value'}),null);
 h.state.orderData.Amazon.orders[0].qty=8;assert.equal(await h.ctx.readParserRejectedUploadProof({readyRetryToken:nextToken}),null);
 assert.equal(h.state.lastSheetsUploadRunId,undefined);
});

test('volatile work starting during archive proof read prevents a quiescent handoff',async()=>{const h=harness({beforeGet(h,keys){if(h.flipProof&&keys.includes(archiveKey))vm.runInContext('isProcessingScreenshots=true',h.ctx)}});await assert.rejects(h.run());h.flipProof=true;assert.equal(await h.ctx.readParserRejectedUploadProof(),null)});

const MANUAL_AT=Date.parse('2026-09-07T13:00:00Z');
const MANUAL_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fullFunction(name) {
 const match=new RegExp(`(?:async )?function ${name}\\(`).exec(source);
 assert.ok(match,name);const end=source.indexOf('\n}\n',match.index);assert.ok(end>match.index);
 return source.slice(match.index,end+2);
}
function readySuccessor(h,{manual=true}={}) {
 installCanonicalDoor(h);
 vm.runInContext(fullFunction('nightCabinetSlotDay'),h.ctx);
 const now=h.ctx.Date.now(),slot=manual?MANUAL_AT:Date.parse('2026-09-08T03:00:00Z');
 const token=manual?`control:${MANUAL_ID}:parser-1`:'night:2026-09-07:successor-fixture';
 const envelope={schemaVersion:1,kind:'manual-control',id:MANUAL_ID,requestSha:'a'.repeat(64),
  coordinatorRunId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',createdAt:MANUAL_AT,
  deadlineAt:MANUAL_AT+6*3600000,nextNativeAdmissionAt:Date.parse('2026-09-08T00:30:00Z')};
 const key=`manualControlGeneration:${MANUAL_ID}`;
 h.state.nightCabinetLease={owner:'parser',phase:'ready',slotId:String(slot),token,heartbeat:now,expires:now+900000};
 if(manual){h.state.manualControlGenerationIndex=[MANUAL_ID];h.state[key]={schemaVersion:1,envelope,admittedAt:MANUAL_AT,parserRunId:null};}
 else h.ctx.nightCabinetLeaseSlotIds=()=>[String(slot)];
 return{token,key,envelope,lease:structuredClone(h.state.nightCabinetLease)};
}
for(const manual of [true,false])test(`unchanged rejected archive is readable under the next ${manual?'manual':'native'} canonical ready slot`,async()=>{
 const h=harness({now:MANUAL_AT});await assert.rejects(h.run());
 const archive=structuredClone(h.state[archiveKey]),raw=structuredClone(h.state.orderData),n=h.writes.length;
 const {token}=readySuccessor(h,{manual});
 assert.equal(await h.ctx.readParserRejectedUploadProof(),null,'old owner cannot be invented');
 const proof=await h.ctx.readParserRejectedUploadProof({readyRetryToken:token});
 assert.equal(proof?.archiveVerified,true);assert.equal(proof?.runId,RUN);
 assert.deepEqual(h.state[archiveKey],archive);assert.deepEqual(h.state.orderData,raw);
 assert.equal(h.writes.length,n);assert.equal(h.post+h.append+h.success,0);
});
for(const bad of ['expired','foreign-token','consumed','missing-envelope','changed-envelope','missing-index','pending','raw-change','archive-change'])
 test(`successor proof ${bad} cannot release the previous data`,async()=>{
  const h=harness({now:MANUAL_AT});await assert.rejects(h.run());const next=readySuccessor(h);
  if(bad==='expired')h.state.nightCabinetLease.expires=MANUAL_AT;
  if(bad==='foreign-token')h.state.nightCabinetLease.token='foreign-ready-token';
  if(bad==='consumed')h.state[next.key].parserRunId='already-created';
  if(bad==='missing-envelope')delete h.state[next.key];
  if(bad==='changed-envelope')h.state[next.key].envelope.createdAt--;
  if(bad==='missing-index')h.state.manualControlGenerationIndex=[];
  if(bad==='pending')h.state.pendingSheetsUpload={runId:RUN};
  if(bad==='raw-change')h.state.orderData.Amazon.orders[0].qty=7;
  if(bad==='archive-change')h.state[archiveKey].json+=' ';
  const n=h.writes.length;assert.equal(await h.ctx.readParserRejectedUploadProof({readyRetryToken:next.token}),null);
  assert.equal(h.writes.length,n);assert.equal(h.post+h.append+h.success,0);
 });
test('generation consumed during archive read cannot pass the final successor check',async()=>{
 const h=harness({now:MANUAL_AT,beforeGet(h,keys){if(h.flipProof&&keys.includes(archiveKey))h.state[`manualControlGeneration:${MANUAL_ID}`].parserRunId='concurrent-run'}});
 await assert.rejects(h.run());const next=readySuccessor(h);h.flipProof=true;
 assert.equal(await h.ctx.readParserRejectedUploadProof({readyRetryToken:next.token}),null);
});
test('actual daily start consumes one manual run after rejected prior data, preserving its archive and raw rows',async()=>{
 const h=harness({now:MANUAL_AT});await assert.rejects(h.run());const next=readySuccessor(h);
 const archive=structuredClone(h.state[archiveKey]),raw=structuredClone(h.state.orderData);
 Object.assign(h.ctx,{loadAccountsConfig:async()=>({}),buildExpectedPipelineRoster:()=>({iherb:[],ebay:[],amazon:[]}),
  addDailyDiagnostic:async()=>{},clearNightCabinetRetry:async()=>{},clearParsingLogs:async()=>{},
  cachedProgressState:{},parseReport:{},startSequentialPipeline:async()=>({started:true})});
 vm.runInContext([fullFunction('createPipelineRun'),fullFunction('runDailyAutoParseOnce')].join('\n'),h.ctx);
 assert.equal(await h.ctx.runDailyAutoParseOnce('coordinator-control',{external:true,slotId:next.lease.slotId,token:next.token}),true);
 assert.notEqual(h.state.pipelineRun.id,RUN);assert.equal(h.state.pipelineRun.slotAt,MANUAL_AT);
 assert.equal(h.state[next.key].parserRunId,h.state.pipelineRun.id);
 assert.equal(h.state.nightCabinetLease.runId,h.state.pipelineRun.id);
 assert.deepEqual(h.state[archiveKey],archive);assert.deepEqual(h.state.orderData,raw);
 const current=h.state.pipelineRun.id;
 await assert.rejects(h.ctx.createPipelineRun('coordinator-control',next.lease),/lease lost/);
 assert.equal(h.state.pipelineRun.id,current);assert.equal(h.post+h.append+h.success,0);
});
