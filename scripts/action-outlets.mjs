#!/usr/bin/env node
/**
 * 🔴 **操作 → 出口の対応表**(#582 の研究 R1 / R7)。
 *
 * ## なぜ要るか
 *
 * PKC3 には受け手(`data-pkc-action` の handler)が 197 種あるのに、
 * 「**この操作は画面のどこから押せるか**」を答える物が **1 つも無かった**。
 * ⚠ だから「届いていない操作」が静かに溜まる ── 実際、#500 で
 * 「右ペインが唯一の入口」の 6 種が**畳むと画面ごと消える**ことが分かった。
 *
 * 🔑 ここが出すのは**表**であって判定ではない。判定は
 * `tests/repo-hygiene-outlets.test.ts` が既知リストと突き合わせる。
 *
 * ## ⚠ この走査の限界(**先に書く**)
 *
 * 出口は 3 通りの書かれ方をする:
 *   ① `setAttribute('data-pkc-action', 'x')` / `data-pkc-action="x"` … 直書き
 *   ② `iconButton('x', …)` / `btn('x', …)` / `{ action: 'x' }` … 助っ人・表
 *   ③ 🔴 `setAttribute('data-pkc-action', it.action)` … **変数**
 *
 * ⚠ ③は**静的には追えない**。だからこの script は「出口が見つからない」を
 * **「出口が無い」と読んではいけない** ── `unresolved` として別に出す。
 * 🔑 それでも価値がある:③で配る表(右クリック / パレット)は**有限**なので、
 * そこを別途 import して足せば、残りは人が 1 度見れば済む量に落ちる。
 *
 *   node scripts/action-outlets.mjs          # 人が読む表
 *   node scripts/action-outlets.mjs --json   # test が読む
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * repo の根。
 *
 * ⚠ **`import.meta.url` から引かない**(2026-08-29 に 2 度踏んだ)──
 *   `new URL('..').pathname` は vitest 経由で壊れ、`fileURLToPath` は
 *   **vitest の `import.meta.url` が `file:` ではない**ので投げる。
 * 🔑 **cwd から上へ `package.json` を探す** ── CLI も vitest も repo の根で走るので
 *   これで両方通る。⚠ 見つからなければ**黙らずに投げる**(どこを見ているか分からない
 *   まま「0 件」と答えるのが、いちばん悪い形である)。
 */
function repoRoot() {
  let d = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(d, 'package.json'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`repo の根が見つからない(cwd=${process.cwd()})`);
}
const ROOT = repoRoot();
const rd = (p) => readFileSync(join(ROOT, p), 'utf-8');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (rel.endsWith('.ts')) out.push(rel.split(sep).join('/'));
  }
  return out;
}

/**
 * 受け手(binder の `ACTIONS` 表)。⚠ ここが唯一の正本。
 *
 * 🔴 **中括弧を数えて表の終端まで**で切る(2026-08-29 に実測で直した)。
 * ⚠ 1 稿目は `t.slice(at)` の**末尾まで**走査していたので、表の**外**に在る
 *   別の表(`format-bold` / `insert-snippet` など 21 件)まで拾い、
 *   **204 種**と出した(真は **183 種**)。名前が**それらしい**ので気づけない。
 * 🔑 「表の中だけ」を主張する走査は、**終端を自分で決めなければならない**。
 */
function tableSegment() {
  const t = rd('src/adapter/ui/actions/binder.ts');
  const key = 'const ACTIONS: Record<string, ActionHandler> = {';
  const at = t.indexOf(key);
  if (at < 0) throw new Error('受け手の表を見つけられない(binder.ts の形が変わった)');
  let i = at + key.length - 1;
  const start = i;
  let depth = 0;
  let str = null;
  let esc = false;
  let end = -1;
  for (; i < t.length; i += 1) {
    const c = t[i];
    if (str !== null) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === str) str = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') str = c;
    else if (t.startsWith('//', i)) i = t.indexOf('\n', i) < 0 ? t.length : t.indexOf('\n', i);
    else if (t.startsWith('/*', i)) i = t.indexOf('*/', i) < 0 ? t.length : t.indexOf('*/', i) + 1;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) throw new Error('受け手の表の終端を見つけられない(括弧が閉じていない)');
  return t.slice(start, end);
}

/** 受け手の名前。⚠ 表の中だけ(上の終端で切ってある)。 */
export function receivers() {
  return [...tableSegment().matchAll(/^ {2}'([a-z0-9-]+)':/gm)].map((m) => m[1]);
}

/**
 * 受け手 1 件ぶんの**本文**。⚠ **表の中だけ**を切る(`receivers()` と同じ終端)。
 *
 * 🔴 **同じ綴りが表の外にも在る**(`insert-snippet` / `insert-entry-link` など)。
 * ⚠ だから「`binder.ts` の先頭から `^  'x':` を探す」形だと、
 *   **どちらの本文を掴むかが呼び側で変わる** ── 2026-08-29 に実際に
 *   「生成した一覧」と「検査した一覧」が 1 件だけ食い違った。
 * 🔑 だから**ここ 1 か所**で切り、呼び側には切らせない(§7)。
 *
 * ⚠ 表の中に同じ綴りは**出ない**(`tableSegment()` で切ってあるため)。
 *   1 稿目は「最初の出現だけ採る」ガードを置いていたが、**変異試験 E2 が
 *   SURVIVED で教えた ── その 1 行は no-op** だった(外して壊れない)。
 *   🔑 重複が起きないことは `tests/action-outlets.test.ts` が等値で pin している。
 */
export function handlers() {
  const seg = tableSegment();
  const ent = [...seg.matchAll(/^ {2}'([a-z0-9-]+)':/gm)].map((m) => ({ n: m[1], i: m.index }));
  const out = new Map();
  for (let k = 0; k < ent.length; k += 1) {
    const end = k + 1 < ent.length ? ent[k + 1].i : seg.length;
    out.set(ent[k].n, seg.slice(ent[k].i, end));
  }
  return out;
}

/** 画面に出している所。⚠ 上の①②だけ。③は追えない(docstring)。 */
export function outlets(names) {
  const known = new Set(names);
  const found = new Map();
  const add = (n, where) => {
    if (!known.has(n)) return;
    if (!found.has(n)) found.set(n, new Set());
    found.get(n).add(where);
  };
  for (const f of walk('src')) {
    if (f === 'src/adapter/ui/actions/binder.ts') continue; // 受け手の表は出口ではない
    const t = rd(f);
    const where = relative('src', f).split(sep).join('/');
    for (const re of [
      /data-pkc-action['"]?\s*,\s*['"]([a-z0-9-]+)['"]/g,
      /data-pkc-action=["']([a-z0-9-]+)["']/g,
      /iconButton\(\s*'([a-z0-9-]+)'/g,
      /\bbtn\(\s*'([a-z0-9-]+)'/g,
      /action:\s*'([a-z0-9-]+)'/g,
    ]) {
      for (const m of t.matchAll(re)) add(m[1], where);
    }
  }
  return found;
}

/** 鍵・パレットから撃てるもの(`keymap.ts` の登記)。 */
export function fromKeymap(names) {
  const known = new Set(names);
  return new Set(
    [...rd('src/features/keymap.ts').matchAll(/id: '([a-z0-9-]+)'/g)]
      .map((m) => m[1])
      .filter((n) => known.has(n)),
  );
}

export function report() {
  const names = receivers();
  const out = outlets(names);
  const keys = fromKeymap(names);
  const rows = names.map((n) => ({
    action: n,
    screens: [...(out.get(n) ?? [])].sort(),
    key: keys.has(n),
  }));
  return {
    receivers: names.length,
    withScreen: rows.filter((r) => r.screens.length > 0).length,
    onlyKey: rows.filter((r) => r.screens.length === 0 && r.key).length,
    unresolved: rows.filter((r) => r.screens.length === 0 && !r.key).map((r) => r.action).sort(),
    rows,
  };
}

if (process.argv[2] === '--json') {
  console.log(JSON.stringify(report(), null, 2));
} else if (process.argv[1] && process.argv[1].endsWith('action-outlets.mjs')) {
  const r = report();
  console.log(`受け手 ${r.receivers} 種`);
  console.log(`  画面に出口が見つかった : ${r.withScreen}`);
  console.log(`  鍵・パレットだけ       : ${r.onlyKey}`);
  console.log(`  ⚠ 出口を静的に追えない : ${r.unresolved.length}(変数で配る経路。人が 1 度見る)`);
  for (const n of r.unresolved) console.log(`      ${n}`);
}
