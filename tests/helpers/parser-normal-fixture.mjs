import crypto from 'node:crypto';
import vm from 'node:vm';

// Component suites keep their existing shop/storage models. The real normal
// fence races and native/browser-session refusal are tested separately in
// parser-work-fence.test.mjs and the cross-extension contract suite.
export function installParserComponentAdmission(context) {
  context.PARSER_WORK_AUTHORITY_KEY = 'parserWorkAuthority';
  context.parserWorkRequire = async runId => {
    const local = context.chrome?.storage?.local;
    const state = local ? await local.get(['pipelineRun','amazonParserTabId','iherbParserTabId','ebayParserTabId']) : {};
    return { record: { runId: runId || state.pipelineRun?.id || 'component-run' },
      ownedTabs: [state.amazonParserTabId,state.iherbParserTabId,state.ebayParserTabId].filter(Number.isSafeInteger) };
  };
  context.parserWorkRememberTab = async () => {};
  context.parserWorkCreateTab = options => context.chrome.tabs.create(options);
}

export function installNativeParserFixture(context, source) {
  if (!context.chrome?.storage?.local) return;
  const actual = name => {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    if (!match) throw Error(name);
    const end = source.indexOf('\n}\n',match.index);
    return source.slice(match.index,end+2);
  };
  context.crypto ||= crypto.webcrypto;
  const session = {};
  context.chrome.storage.session = { get: async () => structuredClone(session),
    set: async value => Object.assign(session,structuredClone(value)) };
  const local=context.chrome.storage.local, get=local.get.bind(local);
  local.get=async keys=>{
    const result=await get(keys);
    if((keys==='parserWorkNativeAdmission'||Array.isArray(keys)&&keys.includes('parserWorkNativeAdmission'))
      &&result.parserWorkNativeAdmission===undefined){
      const lease=(await get('nightCabinetLease')).nightCabinetLease;
      if(lease)result.parserWorkNativeAdmission={schemaVersion:1,kind:'parser-native-admission',slotId:lease.slotId,token:lease.token,
        createdAt:context.Date?.now?.()||Date.now(),owner:{hostId:'pittsburgh',bootId:'00000000-0000-4000-8000-000000000001',pid:42,ppid:1,pgid:42,
          processStartFingerprint:'fixture-native-start',commandSha:'a'.repeat(64),runId:'fixture-native'},descriptorSha:'b'.repeat(64)};
    }
    return result;
  };
  vm.runInContext([actual('parserWorkNativeAdmissionValid'),actual('parserWorkBrowserSession')].join('\n'),context);
}
