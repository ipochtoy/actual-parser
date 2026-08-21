import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  chromePreferenceFiles, extensionPreferenceVerdict, readExtensionInstallation,
} from '../watchdog/lib/extension-installation.mjs';

const ID = 'hglkogmefkopebgipcnmfmnhflnhajbo';
const pref = row => ({ extensions: { settings: { [ID]: row } } });

test('preference proof distinguishes enabled, missing and unreadable without browser actions', () => {
  assert.equal(extensionPreferenceVerdict([], ID).state, 'unknown');
  assert.equal(extensionPreferenceVerdict([{}], ID).state, 'missing');
  assert.equal(extensionPreferenceVerdict([pref({ state: 0, manifest: { name: 'Pochtoy Parsing' } })], ID).state, 'missing');
  assert.equal(extensionPreferenceVerdict([pref({ state: 1, manifest: { name: 'Pochtoy Parsing' } })], ID).state, 'installed');
  assert.equal(extensionPreferenceVerdict([pref({ location: 4, path: '/repo/parser' })], ID, {
    expectedPath: '/repo/parser',
  }).state, 'installed', 'live unpacked Secure Preferences omits state and manifest');
  assert.equal(extensionPreferenceVerdict([pref({ location: 4, path: '/foreign' })], ID, {
    expectedPath: '/repo/parser',
  }).state, 'missing');
  assert.equal(extensionPreferenceVerdict([pref({ location: 4, path: '/repo/parser', disable_reasons: [1] })], ID, {
    expectedPath: '/repo/parser',
  }).state, 'missing');
  assert.equal(extensionPreferenceVerdict([pref({ state: 1, manifest: { name: 'Foreign' } })], ID).state, 'missing');
});

test('filesystem reader is bounded to Chrome profile preference files', t => {
  const root = mkdtempSync(join(tmpdir(), 'parser-watchdog-prefs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'Default'));
  mkdirSync(join(root, 'Profile 2'));
  mkdirSync(join(root, 'System Profile'));
  writeFileSync(join(root, 'Default', 'Preferences'), JSON.stringify(pref({ state: 1, manifest: { name: 'Pochtoy Parsing' } })));
  writeFileSync(join(root, 'Profile 2', 'Preferences'), '{}');
  assert.equal(chromePreferenceFiles(root).length, 4);
  assert.equal(readExtensionInstallation({ userDataRoot: root, extensionId: ID, manifestName: 'Pochtoy Parsing' }).state, 'installed');
});

test('partial unreadable preference snapshot is unknown and never exact missing', t => {
  const root = mkdtempSync(join(tmpdir(), 'parser-watchdog-partial-prefs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'Default'));
  writeFileSync(join(root, 'Default', 'Preferences'), '{}');
  writeFileSync(join(root, 'Default', 'Secure Preferences'), '{chrome-is-replacing-this-file');

  assert.deepEqual(readExtensionInstallation({
    userDataRoot: root, extensionId: ID, manifestName: 'Pochtoy Parsing',
  }), { state: 'unknown', reason: 'preferences-partially-unreadable' });

  writeFileSync(join(root, 'Default', 'Secure Preferences'), '{}');
  assert.deepEqual(readExtensionInstallation({
    userDataRoot: root, extensionId: ID, manifestName: 'Pochtoy Parsing',
  }), { state: 'missing', reason: 'preference-entry-absent' });
});

test('canonical launchd pins exact Chrome data root and extension path', () => {
  const plist = readFileSync(new URL('../watchdog/com.pochtoy.parser-watchdog.plist', import.meta.url), 'utf8');
  assert.match(plist, /<key>PARSER_CHROME_USER_DATA_DIR<\/key>\s*<string>\/Users\/dzianismazol\/Library\/Application Support\/Google\/Chrome<\/string>/);
  assert.match(plist, /<key>PARSER_EXTENSION_PATH<\/key>\s*<string>\/Users\/dzianismazol\/Desktop\/order-parser-pro<\/string>/);
});

test('external watchdog contains no tab creation, navigation or popup probe', () => {
  const source = readFileSync(new URL('../watchdog/parser-watchdog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/json\/new|\/json\/close|Target\.createTarget|popup\.html/);
  assert.match(source, /readExtensionInstallation/);
  assert.match(source, /ext_not_installed/);
});
