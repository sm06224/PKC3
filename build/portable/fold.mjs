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
import {
  bundleTagCount,
  externalRefs,
  shellOf,
  PORTABLE_HEAD_SCAN,
} from './shell-scan.mjs';

const DIR = process.argv[2] ?? 'dist-portable';
const OUT = process.argv[3] ?? join(DIR, 'pkc3.html');
const A = join(DIR, 'assets');

/**
 * 🔴 **雛形の id は版をまたいで変えない**(#400 段③)。
 *
 * `file://` では器(IndexedDB)が **scheme 全体で 1 個**なので、この id が
 * そのまま「どの器に書くか」になる。⚠ もし中身の hash から導くと、
 * **アプリを更新して落とし直した瞬間に、前の版で書いたノートが行方不明**になる
 * ── user から見れば「新しいのを開いたら空だった」である。
 * 🔑 だから雛形は**固定**。書き出し(段④)は 1 回ごとに別の id を焼くので、
 * 雛形と書き出し物が同じ器を掴むことはない。
 * ⚠ `exportedAt` は **0**(= 中身を配っていない)。雛形には DB 画像が無いので、
 * 「配られた画像のほうが新しいか」を比べる相手がそもそも居ない。
 */
const TEMPLATE_BUNDLE_ID = process.env.PKC3_BUNDLE_ID ?? 'pkcb-template';
const BUNDLE_TAG =
  `<script type="application/json" data-pkc-bundle>` +
  JSON.stringify({ id: TEMPLATE_BUNDLE_ID, exportedAt: 0 }) +
  `</script>`;

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

/**
 * 🔴 **器いじりは、中身を流し込む「前」に全部やる**(2 稿目。1 稿目で起動を壊した)。
 *
 * ⚠ 1 稿目は畳んだ後に `.replace('</head>', …)` していた ── ところが
 *   **アプリ本体は書き出し用の HTML を組む文字列**を持っており、その中に
 *   `</head>` が実在する。`String.replace` は**最初の 1 件**を書き換えるので、
 *   印が **JS の途中に差し込まれ**、`SyntaxError: missing ) after argument list`
 *   で真っ白になった。
 * 🔑 CLAUDE.md §1「範囲が広すぎて無関係な散文に満たされる」── この file の
 *   下の tripwire がまさにそれを戒めているのに、**同じ file でもう一度踏んだ**。
 *   だから順番を規則にする:**器 → 中身**。
 */
html = html
  // ⚠ 外の file を指す物は落とす(`file://` では 404 になるだけ)
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replace(/\s*<link rel="icon"[^>]*>/, '')
  /**
   * 🔴 **可搬バンドルの印**(#400 段③④)。⚠ これが無いと、畳んだ HTML は
   *   `file://` で開いても**器を持たない**(再読込で消える)。
   * 🔴 **`<head>` の直後に置く** ── 書き出し(段④)は雛形の**先頭だけ**を見て
   *   印を差し替えるからである(全体を見ると、畳んだ JS の中の同じ綴りに当たる)。
   */
  .replace('<head>', () => `<head>${BUNDLE_TAG}`);
if (!html.includes(BUNDLE_TAG))
  throw new Error('可搬バンドルの印を差し込めなかった(<head> に当たらない)');

html = html
  .replace(/<script type="module"[^>]*><\/script>/, () => `<script type="module">${app}</script>`)
  .replace(/<link rel="stylesheet"[^>]*>/, () => `<style>${css}</style>`);

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
const shell = shellOf(html);
if (!shell.includes('data-pkc-slot="root"'))
  throw new Error('器を抜きすぎている(検査そのものが空振りしている)');
const left = externalRefs(shell);
if (left.length > 0) throw new Error(`外部参照が残っている: ${left.join(' / ')}`);
for (const mark of ['data-pkc-slot="root"', 'createObjectURL']) {
  if (!html.includes(mark)) throw new Error(`畳んだ HTML に「${mark}」が無い(中身が落ちている)`);
}
/**
 * 🔴 **印は「器の側」で数える**(1 稿目の壊れ方を、二度と通さないための門)。
 *
 * ⚠ `html.includes('data-pkc-bundle')` では**足りない** ── 印が JS の途中へ
 *   差し込まれても真になる(1 稿目はまさにその形で通っていた)。
 * 🔑 `shell` は `<script>` の**中身を抜いた**後なので、ここに在るということは
 *   **document の器に在る**ということである。⚠ そして 1 件だけであること
 *   (2 件差し込むと、後から読むほうが勝つ形になる)。
 */
const tags = bundleTagCount(shell);
if (tags !== 1)
  throw new Error(`可搬バンドルの印が器に ${tags} 件(1 件でなければならない)`);
/**
 * 🔴 **印が「頭」に在ること**(段④ の差し替えが見る範囲に収まっている)。
 * ⚠ ここが外れると、書き出しは**印を 1 件も見つけられずに落ちる** ──
 *   落ちるだけましだが、原因が畳む側に在ることが分からない。
 */
const tagAt = html.indexOf(BUNDLE_TAG);
if (tagAt < 0 || tagAt >= PORTABLE_HEAD_SCAN)
  throw new Error(`印の位置が ${tagAt} バイト目(頭 ${PORTABLE_HEAD_SCAN} バイト以内でなければならない)`);

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
console.log(
  `畳みました: ${OUT} ${mb(statSync(OUT).size)}` +
    `(worker ${swapped} 本 / wasm ${mb(readFileSync(join(A, wasm)).length)} / 器 ${TEMPLATE_BUNDLE_ID})`,
);
