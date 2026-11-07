const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveHubSecret } = require('../src/hub-secret');

function home(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-secret-'));
  if (content !== undefined) {
    fs.mkdirSync(path.join(dir, '.config', 'koach-os'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.config', 'koach-os', 'secrets.env'), content);
  }
  return dir;
}

test('設定に値があればそれを優先する', () => {
  assert.strictEqual(resolveHubSecret('from-config', { homeDir: home('KOACH_API_TOKEN=file') }), 'from-config');
});

test('設定が空なら鍵ファイルから読む', () => {
  assert.strictEqual(resolveHubSecret('', { homeDir: home('OTHER=x\nKOACH_API_TOKEN=abc123\n') }), 'abc123');
});

test('export と引用符を外す', () => {
  assert.strictEqual(resolveHubSecret('', { homeDir: home('export KOACH_API_TOKEN="abc=1"\n') }), 'abc=1');
});

test('鍵ファイルが無ければ空', () => {
  assert.strictEqual(resolveHubSecret('', { homeDir: home() }), '');
});

test('行が無ければ空', () => {
  assert.strictEqual(resolveHubSecret('', { homeDir: home('# KOACH_API_TOKEN=commented\n') }), '');
});
