/**
 * 🔴 **1 個の HTML に畳む**(#400 段①②)。
 *
 * `vite build --config build/portable.config.ts` の出力(単一チャンク)を、
 * **外部参照が 1 件も無い 1 個の HTML** にする。
 *
 * ## なぜ後処理が要るのか(Vite だけでは畳めない 2 つ)
 *
 * 1. 🔴 **worker** ── `worker.format: 'iife'` にしても、呼び出し側は
 *    `new Worker(new URL('…'), { type: 'module' })` のまま残る(Vite の
 *    `worker-import-meta-url` は URL しか書き換えない)。
 *    ⚠ `file://` では **module worker が起動しない**(設計 doc §2 の実測)。
 *    🔑 出力された worker は**既に iife**(`import` 0 件)なので、
 *    **classic の blob worker** に差し替えれば通る。
 * 2. 🔴 **wasm** ── sqlite の loader は `self.location.href` から相対で解決する。
 *    blob worker では `self.location.href` が `blob:…` になり、**解決できない**。
 *    🔑 その式を **`data:` URL の literal** に差し替える。
 *
 * ## ⚠ 下限の tripwire を置く(CLAUDE.md「上限だけでなく下限も」)
 *
 * 単一化は「参照が消えて縮む」方向に壊れる ── size cap だけでは
 * **0 バイトの HTML** を通してしまう。だからここは
 * **①外部参照が 0 件 ②主要な印が全部入っている**の両方を確かめて落とす。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

const DIR = process.argv[2] ?? 'dist-portable';
const OUT = process.argv[3] ?? join(DIR, 'pkc3.html');
const A = join(DIR, 'assets');

const files = readdirSync(A);
const pick = (re) => {
  const hit = files.filter((f) => re.test(f));
  if (hit.length !== 1) throw new Error(`${re} に当たる file が ${hit.length} 件(1 件でないと畳めない)`);
  return hit[0];
};

const b64 = (name) => readFileSync(join(A, name)).toString('base64');

/**
 * 🔑 **UTF-8 のまま復号する** ── worker には日本語の文言が入っている。
 * ⚠ `atob` だけだと**バイト列を文字コードとして読む**ので、日本語が壊れる
 * (画面に出る断り文が化ける ── 出るまで気づけない形である)。
 */
const DECODE =
  'function(b){var s=atob(b),u=new Uint8Array(s.length);' +
  'for(var i=0;i<s.length;i++)u[i]=s.charCodeAt(i);' +
  'return new TextDecoder().decode(u);}';

// ── ① wasm を data: にして、worker の中の解決式を差し替える
const wasm = pick(/^sqlite3-.*\.wasm$/);
const wasmUrl = `data:application/wasm;base64,${b64(wasm)}`;
const workerNames = files.filter((f) => /-worker-|worker1|opfs-async-proxy/.test(f) && f.endsWith('.js'));
if (workerNames.length === 0) throw new Error('worker が 1 件も見つからない(畳む対象が無い)');

const workerSrc = new Map();
for (const name of workerNames) {
  let src = readFileSync(join(A, name), 'utf-8');
  // ⚠ 解決式ごと置き換える(部分置換だと `self.location.href` が残る)
  const before = src;
  src = src.replaceAll(
    new RegExp(
      'new URL\\(``\\+new URL\\(`' + wasm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '`,self\\.location\\.href\\)\\.href,``\\+self\\.location\\.href\\)\\.href',
      'g',
    ),
    JSON.stringify(wasmUrl),
  );
  workerSrc.set(name, src);
  if (name.startsWith('storage-worker') && src === before)
    throw new Error('storage worker の wasm 解決式に当たらなかった(上流の形が変わった)');
}

// ── ② 呼び出し側を classic の blob worker へ差し替える
let app = readFileSync(join(A, pick(/^index-.*\.js$/)), 'utf-8');
let swapped = 0;
for (const [name, src] of workerSrc) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /**
   * ⚠ **外側の `.href` は付いたり付かなかったりする**(実測)── 綴りを 1 通りに
   *   決め打つと、当たらないまま「畳んだ」ことになる。だから optional にして、
   *   ⚠ **1 件も当たらなければ落とす**(下の `swapped === 0`)。
   */
  const re = new RegExp(
    'new Worker\\(new URL\\(``\\+new URL\\(`' + esc +
      '`,import\\.meta\\.url\\)\\.href,``\\+import\\.meta\\.url\\)(?:\\.href)?,\\{type:`module`\\}\\)',
    'g',
  );
  const blob =
    `new Worker(URL.createObjectURL(new Blob([(${DECODE})(${JSON.stringify(
      Buffer.from(src, 'utf-8').toString('base64'),
    )})],{type:"text/javascript"})))`;
  const n = (app.match(re) ?? []).length;
  app = app.replace(re, blob);
  swapped += n;
}
if (swapped === 0) throw new Error('worker の作り方に 1 件も当たらなかった(上流の形が変わった)');

// ── ③ HTML へ畳む
const css = readFileSync(join(A, pick(/^index-.*\.css$/)), 'utf-8');
let html = readFileSync(join(DIR, 'index.html'), 'utf-8');
html = html
  .replace(/<script type="module"[^>]*><\/script>/, () => `<script type="module">${app}</script>`)
  .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`)
  // ⚠ 外の file を指す物は落とす(`file://` では 404 になるだけ)
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replace(/\s*<link rel="icon"[^>]*>/, '');

// ── ④ 🔴 下限の tripwire(縮む方向の壊れを止める)
/**
 * 🔴 **見るのは器だけ**(2 稿目。1 稿目は落ちて分かった)。
 *
 * ⚠ 1 稿目は HTML 全体を走査したので、**埋め込んだ JS の中の文字列**
 *   (`` `src="${e}"` `` のような組み立て)に当たって必ず落ちた ──
 *   CLAUDE.md §1「範囲が広すぎて無関係な散文に満たされる」そのものである。
 * 🔑 `<script>` / `<style>` の**中身を抜いてから**見る。
 * ⚠ 抜いた後の器が空になっていないことも確かめる(抜きすぎの空振り防止)。
 */
const shell = html
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '<style></style>');
if (!shell.includes('data-pkc-slot="root"'))
  throw new Error('器を抜きすぎている(検査そのものが空振りしている)');
const left = [...shell.matchAll(/(?:src|href)="(?!data:|#)[^"]+"/g)].map((m) => m[0]);
if (left.length > 0) throw new Error(`外部参照が残っている: ${left.join(' / ')}`);
for (const mark of ['data-pkc-slot="root"', 'createObjectURL']) {
  if (!html.includes(mark)) throw new Error(`畳んだ HTML に「${mark}」が無い(中身が落ちている)`);
}
/**
 * 🔴 **wasm は「字面」では探せない**(2 稿目。1 稿目は落ちて分かった)。
 *
 * ⚠ wasm の `data:` URL は **worker の中**に在り、その worker は**さらに base64**
 *   されて HTML に入る ── だから `html.includes('data:application/wasm')` は
 *   **常に偽**である(自分で二重に符号化した物を、字面で探していた)。
 * 🔑 届いたことは**量**で見る:wasm の base64 は最低でもその長さぶん HTML を
 *   膨らませる(二重符号化でさらに 4/3)。⚠ 上限ではなく**下限**である
 *   (CLAUDE.md「tripwire は上限だけでなく下限も」── 縮む方向の壊れを止める)。
 * 🔑 差し替えが**当たったこと自体**は、上の `storage worker の wasm 解決式に
 *   当たらなかった` が既に落としている(そちらが本体の門)。
 */
const wasmB64 = wasmUrl.length;
if (html.length < wasmB64) throw new Error(`wasm が入っていない(HTML ${html.length} < wasm ${wasmB64})`);
if (html.length < 3_000_000) throw new Error(`畳んだ HTML が小さすぎる: ${html.length} バイト`);

writeFileSync(OUT, html);
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`畳みました: ${OUT} ${mb(statSync(OUT).size)}(worker ${swapped} 本 / wasm ${mb(readFileSync(join(A, wasm)).length)})`);
