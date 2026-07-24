import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const TELEGRAM_TOKEN = /[0-9]{6,12}:[A-Za-z0-9_-]{30,50}/;

test('tracked production files contain no Telegram bot token', () => {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);

  const locations = [];
  for (const path of files) {
    if (/^(?:test|tests|fixtures)\//.test(path)) continue;
    const text = readFileSync(new URL(path, ROOT), 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      if (TELEGRAM_TOKEN.test(line)) locations.push(`${path}:${index + 1}`);
    });
  }

  assert.deepEqual(
    locations,
    [],
    `Telegram bot token found at: ${locations.join(', ')}`,
  );
});

test('parser and watchdog require local runtime credentials', () => {
  const background = readFileSync(new URL('background.js', ROOT), 'utf8');
  const watchdog = readFileSync(new URL('watchdog/parser-watchdog.mjs', ROOT), 'utf8');

  assert.match(background, /let tgBotToken = '';/);
  assert.doesNotMatch(background, /chrome\.storage\.local\.set\(\{\s*tgBotToken\s*\}\)/);
  assert.match(watchdog, /process\.env\.PARSER_TELEGRAM_BOT_TOKEN/);
  assert.match(watchdog, /telegram-creds\.json/);
});
