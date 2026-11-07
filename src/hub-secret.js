// koach-os の hub に付ける鍵を決める。
// 9/12 に koach-os の全 API が鍵必須になったが、Bridgework の設定は空のままで、
// 相談タブの送信が全部 401 で断られていた。本人が手で入れるものではないので、
// 設定が空なら Mac の koach-os の鍵ファイルから読む。値はログにも画面にも出さない。
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveHubSecret(configured, { homeDir = os.homedir() } = {}) {
  if (configured) return configured;
  try {
    const file = path.join(homeDir, '.config', 'koach-os', 'secrets.env');
    for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
      const m = raw.match(/^\s*(?:export\s+)?KOACH_API_TOKEN\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (_) { /* 鍵ファイルが無い Mac では従来どおり鍵なしで呼ぶ */ }
  return '';
}

module.exports = { resolveHubSecret };
