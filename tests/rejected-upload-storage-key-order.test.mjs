import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
const source=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8');
const protocol=source.slice(source.indexOf('// BEGIN REJECTED SHEETS UPLOAD ARCHIVE'),source.indexOf('// END REJECTED SHEETS UPLOAD ARCHIVE'));
const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
const RUN='fixture-run',KEY='parserRejectedUploadArchive:'+RUN,NOW=200000;
function harness({sorted=true,mutateOutcome}={}) {
 const run={id:RUN,status:'degraded',source:'coordinator-control',finishedAt:100000,slotAt:90000,nightSlotDay:'fixture-day',nightRequestToken:'fixture-request-token'};
 const state=sort({pipelineRun:run,pipelineStage:{runId:RUN,active:false,stageName:'done',currentIndex:3,stages:['iherb','ebay','amazon','done']},parsingState:{isParsingAllStores:false},pendingSheetsUpload:{runId:RUN,forSlot:90000,savedAt:110000},trackScreenshotQueue:[],nightCabinetLease:{owner:'parser',phase:'running',runId:RUN,token:run.nightRequestToken,slotId:'90000'},orderData:{Amazon:{orders:[{order_id:'fixture-order',qty:null,items:['first','second']},{order_id:'fixture-order',qty:null,items:['first','second']}]}},sentScreenshots:['ack-first','ack-second'],screenshotArchiveLedger:{schemaVersion:1,entries:{one:{state:'delivered',archive:{link:'fixture-link'}}}}});
 const error=Error('fixture'),writes=[];let generatedOutcome;
 const ctx=vm.createContext({Date:class extends Date{static now(){return NOW}},TextEncoder,crypto:webcrypto,Uint8Array,isParsingAllStores:false,isProcessingScreenshots:false,finalSheetsUploadInFlight:{runId:RUN},uploadToSheets:Object.assign(()=>{},{activeCount:0}),nightCabinetSlotDay:()=>run.nightSlotDay,error,refusal:{runId:RUN,rawJSON:JSON.stringify(state.orderData),destination:{spreadsheetId:'fixture-sheet',sheetName:'fixture'},collision:{qty:[1,'']}},chrome:{storage:{local:{async get(keys){return Object.fromEntries(keys.filter(k=>k in state).map(k=>[k,structuredClone(state[k])]))},async set(patch){writes.push(structuredClone(patch));if(patch.parserRejectedUpload)generatedOutcome=structuredClone(patch.parserRejectedUpload);Object.assign(state,sorted?sort(patch):structuredClone(patch));if(patch.parserRejectedUpload)mutateOutcome?.(state.parserRejectedUpload)}}}}});
 vm.runInContext(protocol+'\nsheetsPrewriteQtyRefusals.set(error,refusal)',ctx);
 return {state,ctx,writes,error,generated:()=>generatedOutcome,archive:()=>vm.runInContext('archiveRejectedSheetsUpload(refusal.runId,error)',ctx),proof:()=>{ctx.finalSheetsUploadInFlight=null;return vm.runInContext('readParserRejectedUploadProof()',ctx)}};
}
test('actual archive and proof survive Chrome key order; bytes, duplicate raw items and ACK remain exact',async()=>{
 const h=harness(),before=structuredClone(h.state);assert.equal(await h.archive(),true);
 assert.equal(h.state.pendingSheetsUpload,null);assert.equal(h.writes.length,2);
 assert.notEqual(JSON.stringify(h.generated()),JSON.stringify(h.state.parserRejectedUpload));assert.deepEqual(h.generated(),h.state.parserRejectedUpload);
 const archived=h.state[KEY],data=JSON.parse(archived.json);assert.deepEqual(data.snapshot.orderData,before.orderData);assert.deepEqual(data.snapshot.sentScreenshots,before.sentScreenshots);assert.deepEqual(data.snapshot.screenshotArchiveLedger,before.screenshotArchiveLedger);
 assert.equal(data.rawRows,2);assert.equal(h.state.parserRejectedUpload.sha256,createHash('sha256').update(archived.json).digest('hex'));assert.equal(h.state.parserRejectedUpload.bytes,Buffer.byteLength(archived.json));
 assert.equal((await h.proof()).archiveVerified,true);assert.equal(h.writes[0][KEY].json,archived.json);
});
test('same fixture without storage key reordering remains supported',async()=>{const h=harness({sorted:false});assert.equal(await h.archive(),true);assert.equal((await h.proof()).archiveVerified,true)});
for(const [label,change] of [
 ['extra key',x=>x.extra=true],['missing key',x=>delete x.priorSheetsWrites],['wrong type',x=>x.rawRows=String(x.rawRows)],['changed destination',x=>x.destination.sheetName='foreign'],['nested extra key',x=>x.destination.extra=true],
])test(`actual outcome readback rejects ${label}`,async()=>{const h=harness({mutateOutcome:change});await assert.rejects(h.archive(),/outcome readback failed/);assert.notEqual(h.error.rejectedUploadArchived,true)});
for(const [label,change] of [
 ['foreign destination',x=>x.destination.spreadsheetId='foreign'],['extra destination field',x=>x.destination.extra=true],['missing destination field',x=>delete x.destination.sheetName],['destination type',x=>x.destination.sheetName=1]
])test(`actual proof refuses ${label}`,async()=>{const h=harness();await h.archive();change(h.state.parserRejectedUpload);assert.equal(await h.proof(),null)});
test('archive string remains byte-sensitive even with semantically identical JSON',async()=>{const h=harness();await h.archive();h.state[KEY].json+=' ';assert.equal(await h.proof(),null)});
test('array order and raw changes remain proof failures',async()=>{const h=harness();await h.archive();h.state.sentScreenshots.reverse();assert.equal(await h.proof(),null)});
const equalCtx=vm.createContext({});vm.runInContext(protocol,equalCtx);
for(const [name,a,b,want] of [
 ['objects reordered','({a:1,b:{x:true,y:null}})','({b:{y:null,x:true},a:1})',true],
 ['arrays preserved','[1,2]','[1,2]',true],['arrays reordered','[1,2]','[2,1]',false],['number/string','1','"1"',false],['extra key','({a:1})','({a:1,b:null})',false],['undefined','undefined','undefined',false],['NaN','NaN','NaN',false],['infinity','Infinity','Infinity',false],['sparse','Array(2)','Array(2)',false],['date','new Date(0)','new Date(0)',false],['cycle','(()=>{let a={};a.a=a;return a})()','(()=>{let a={};a.a=a;return a})()',false],['symbol key','({[Symbol()]:1})','({})',false],['accessor','({get a(){throw Error("unexpected")}})','({a:1})',false]
])test(`semantic equality ${name}`,()=>assert.equal(vm.runInContext(`rejectedUploadJsonEqual(${a},${b})`,equalCtx),want));

test('sparse array cannot hide a hole behind an enumerable non-index key',()=>{
 assert.equal(vm.runInContext(`(()=>{const a=[1],b=[1];a.length=b.length=2;a.foo=b.foo=3;return rejectedUploadJsonEqual(a,b)})()`,equalCtx),false);
});
