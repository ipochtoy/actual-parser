import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function extensionPreferenceVerdict(documents, extensionId, {
  manifestName = 'Pochtoy Parsing', expectedPath = null,
  allExistingCandidatesReadable = true,
} = {}) {
  const readable = (Array.isArray(documents) ? documents : []).filter(doc => doc && typeof doc === 'object');
  if (!allExistingCandidatesReadable) return { state: 'unknown', reason: 'preferences-partially-unreadable' };
  if (!readable.length) return { state: 'unknown', reason: 'preferences-unreadable' };
  let found = null;
  for (const doc of readable) {
    const row = doc?.extensions?.settings?.[extensionId];
    if (!row || typeof row !== 'object') continue;
    found = row;
    const name = String(row?.manifest?.name || '');
    const path = String(row?.path || '');
    // Unpacked location=4 in Chrome Secure Preferences has no `state` field
    // while enabled (live Pittsburgh shape). Explicit state=0 or non-empty
    // disable_reasons is disabled; absence of both is enabled.
    const disabledReasons = row?.disable_reasons;
    const explicitlyDisabled = Number(row?.state) === 0
      || (Array.isArray(disabledReasons) ? disabledReasons.length > 0 : Boolean(disabledReasons));
    const enabled = !explicitlyDisabled && (Number(row?.state) === 1 || row?.state == null);
    const nameMatches = !name || name === manifestName;
    const pathMatches = !expectedPath || path === expectedPath;
    if (enabled && nameMatches && pathMatches) return { state: 'installed', reason: 'enabled-preference' };
  }
  if (found) return { state: 'missing', reason: 'preference-present-but-disabled-or-foreign' };
  return { state: 'missing', reason: 'preference-entry-absent' };
}

export function chromePreferenceFiles(userDataRoot) {
  let names;
  try { names = readdirSync(userDataRoot, { withFileTypes: true }); } catch { return []; }
  return names
    .filter(entry => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
    .flatMap(entry => ['Preferences', 'Secure Preferences'].map(file => join(userDataRoot, entry.name, file)));
}

export function readExtensionInstallation({
  userDataRoot, extensionId, manifestName, expectedPath = null,
} = {}) {
  const documents = [];
  let allExistingCandidatesReadable = true;
  for (const file of chromePreferenceFiles(userDataRoot)) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      // A profile may legitimately have only one of the two preference files.
      // Any other read failure leaves absence unproven and must fail unknown.
      if (error?.code !== 'ENOENT') allExistingCandidatesReadable = false;
      continue;
    }
    try {
      documents.push(JSON.parse(raw));
    } catch {
      // Chrome can replace these files while the watchdog is reading them.
      // Never turn such a partial snapshot into an "extension removed" fact.
      allExistingCandidatesReadable = false;
    }
  }
  return extensionPreferenceVerdict(documents, extensionId, {
    manifestName, expectedPath, allExistingCandidatesReadable,
  });
}
