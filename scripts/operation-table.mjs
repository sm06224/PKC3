#!/usr/bin/env node
/**
 * 🔴 **操作の全数台帳**(#582 段①)。
 *
 * ## ⚠ 段①の題は「4 つの登記簿を寄せる」だったが、実測でそれは的を外していた
 *
 * 数えると、5 つの登記簿(`KEY_COMMANDS` 52 / `ENTRY_MENU_ACTIONS` 11 /
 * `BODY_MENU_ACTIONS` 2 / `COLLECTION_COMMANDS` 2 / `SETTINGS_COMMANDS` 5 =
 * **71 id**)の**重なりは 1 件だけ**(`cycle-read-columns`)である。
 * 🔑 つまり 5 つは**重複ではなく分割**なので、寄せても消える重複が無い
 * (「三つの似た行 > 早すぎる helper」)。
 *
 * 🔴 **本当の穴は別の所に在った ── 「操作」の id 空間が 2 つある**:
 *
 * | | 数 |
 * |---|---|
 * | `data-pkc-action` の受け手 | **183** |
 * | 登記簿に在る id | **71** |
 * | 🔴 **両方に在る** | **30** |
 * | 🔴 **登記簿だけ**(鍵しか無い操作) | **41** |
 * | 🔴 **受け手だけ**(名前で呼べない操作) | **153** |
 *
 * ⚠ だからこの script は「寄せる」のではなく、**2 つの空間を突き合わせて 1 枚にする**。
 * 🔑 これが R7(一貫性の検査)の足場である ── 「畳めない面での出口が 1 つ以上」を
 * 書くには、まず**全部を 1 枚に並べられる**必要がある。
 *
 * ## ⚠ 追えないもの(先に書く)
 *
 * - 受け手だけの 153 件は、**字(label)がこの表から引けない** ── 描画 file の中で
 *   その場で組まれるため。`null` を入れる(**空文字にしない**:「字が無い」と
 *   「引けていない」は別である)。
 * - 出口は静的にしか追えない(`action-outlets.mjs` の docstring の①②のみ)。
 *
 *   node scripts/operation-table.mjs          # 人が読む
 *   node scripts/operation-table.mjs --json   # test が読む
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { outlets, receivers } from './action-outlets.mjs';
import { classify } from './action-scope-survey.mjs';

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

/**
 * 登記簿 1 つを切り出して `{ id, label }` を拾う。
 *
 * ⚠ **配列の終わりで切る**(`action-outlets.mjs` が受け手の表で踏んだのと同じ罠)──
 *   末尾まで走ると、同じ file の**別の表**の行を拾う。
 * ⚠ 空振り防止に **0 件なら投げる** ── 綴りが変わったとき「登記簿が空になった」を
 *   静かに通すと、下の差分が**全部「未登記」へ倒れる**。
 */
function registry(file, name, key, end) {
  const s = rd(file);
  const i = s.indexOf(name);
  if (i < 0) throw new Error(`${name} が ${file} に無い`);
  const j = s.indexOf(end, i);
  if (j < 0) throw new Error(`${name} の終端(${end.trim()})が見つからない`);
  const seg = s.slice(i, j);
  const rows = [];
  for (const m of seg.matchAll(new RegExp(`${key}: '([a-z0-9-]+)'`, 'g'))) {
    const after = seg.slice(m.index, m.index + 400);
    const lab = after.match(/label: '([^']*)'/);
    rows.push({ id: m[1], label: lab ? lab[1] : null });
  }
  if (rows.length === 0) throw new Error(`${name} から 1 件も拾えなかった`);
  return rows;
}

export function registries() {
  return {
    key: registry('src/features/keymap.ts', 'export const KEY_COMMANDS', 'id', '\n];'),
    entry: registry('src/features/entry-actions.ts', 'export const ENTRY_MENU_ACTIONS', 'action', '\n];'),
    body: registry('src/features/entry-actions.ts', 'export const BODY_MENU_ACTIONS', 'action', '\n];'),
    collection: registry('src/adapter/ui/render/commands.ts', 'export const COLLECTION_COMMANDS', 'action', '\n] as const;'),
    settings: registry('src/adapter/ui/render/commands.ts', 'export const SETTINGS_COMMANDS', 'action', '\n] as const;'),
  };
}

/**
 * 🔴 **鍵 → ボタンの橋**(`binder.ts` の `SHORTCUT_BUTTON` / `FORMAT_OF`)。
 *
 * ⚠ **これを読まないと、41 件が「押す口が無い」に見える**(2026-08-30 に踏みかけた)──
 *   `toggle-sidebar` にはボタンが在り、鍵はその**ボタンを押している**。
 * 🔑 2 つの id 空間は**既に橋で繋がっている**。台帳の仕事は、その橋を数えて
 *   **繋がっていない分**を名指しすることである。
 */
function bridges() {
  const t = rd('src/adapter/ui/actions/binder.ts');
  const cut = (name, close) => {
    const i = t.indexOf(name);
    if (i < 0) throw new Error(`${name} が binder.ts に無い`);
    const j = t.indexOf(close, i);
    if (j < 0) throw new Error(`${name} の終端が見つからない`);
    return t.slice(i, j);
  };
  const btn = new Map();
  for (const m of cut('export const SHORTCUT_BUTTON', '\n};').matchAll(/'([a-z0-9-]+)':\s*'([^']+)'/g)) {
    btn.set(m[1], m[2]);
  }
  const fmt = new Set(
    [...cut('const FORMAT_OF', '\n};').matchAll(/'([a-z0-9-]+)':\s*'[a-z]+'/g)].map((m) => m[1]),
  );
  if (btn.size === 0 || fmt.size === 0) throw new Error('橋を 1 件も拾えなかった');
  return { btn, fmt };
}

/** ⚠ 直近の `table()` が**出口の走査に渡した件数**(範囲そのもの)。 */
let lastScanned = 0;
/** 出口を探す。⚠ **渡した集合をその場で数える**(上の注記)。 */
function scanOutlets(names) {
  lastScanned = names.length;
  return outlets(names);
}
/** 走査の範囲。⚠ `table()` を 1 度も呼んでいなければ投げる(0 を返さない)。 */
function scannedCount() {
  if (lastScanned === 0) throw new Error('table() を先に呼ぶこと(走査の範囲が空)');
  return lastScanned;
}

export function table() {
  const recv = receivers();
  const kinds = classify();
  const reg = registries();
  const inReg = new Map();
  for (const [where, rows] of Object.entries(reg)) {
    for (const r of rows) {
      if (!inReg.has(r.id)) inReg.set(r.id, { books: [], label: null });
      const e = inReg.get(r.id);
      e.books.push(where);
      if (e.label === null && r.label !== null) e.label = r.label;
    }
  }
  const ids = [...new Set([...recv, ...inReg.keys()])].sort();
  const recvSet = new Set(recv);
  /**
   * 出口は **全 id** で探す(受け手だけに絞らない)。
   *
   * ⚠ **これは「直し」ではない。実測すると 1 件も増えなかった**(2026-08-30)──
   *   広げた理由に「`toggle-sidebar` が出口 0 件に見えるから」と書きかけたが、
   *   **それは誤り**である:ボタンの綴りは `toggle-pane` + `data-pkc-pane` なので、
   *   `toggle-sidebar` という字は**どちらの走査でも 1 件も当たらない**。
   *   🔑 その誤読を実際に直したのは、下の**橋**(`SHORTCUT_BUTTON`)のほうである。
   * ⚠ それでも広げたまま残す:**増えたら id 空間が混ざり始めた合図**であり、
   *   `tests/operation-table.test.ts` がそれを 0 件で pin している。
   */
  /**
   * 🔴 **渡した物と数える物を、同じ 1 か所にする**(CLAUDE.md §7)。
   *
   * ⚠ 1 稿目は `outlets(ids)` の**次の行**で `lastScanned = ids.length` と書いていたが、
   *   それだと**走査だけを狭めても数字は 224 のまま**なので、範囲の検査が空振りする
   *   (変異試験 M3 が SURVIVED で 2 度教えた)。
   */
  const out = scanOutlets(ids);
  const { btn, fmt } = bridges();
  return ids.map((id) => ({
    id,
    receiver: recvSet.has(id),
    books: inReg.get(id)?.books ?? [],
    label: inReg.get(id)?.label ?? null,
    /**
     * 引数の種別。⚠ 受け手にしか無い(登記簿だけの id は仕分けの対象外)。
     * ⚠ **`classify()` は `Map` を返す** ── 1 稿目は `kinds[id]` と書いたので
     *   **183 件が揃って `null`** になっていた(数字が出ないので空振りに見えず、
     *   下の門を足して初めて分かった)。
     */
    arg: kinds.get(id) ?? null,
    screens: [...(out.get(id) ?? [])].sort(),
    /**
     * どうやって画面の押し所に届くか。
     * ⚠ `null` は「**この走査では辿れない**」であって「届かない」ではない。
     */
    bridge: recvSet.has(id)
      ? 'actions'
      : btn.has(id)
        ? `button:${btn.get(id)}`
        : fmt.has(id)
          ? 'format'
          : null,
  }));
}

export function summary() {
  const rows = table();
  const scanned = scannedCount();
  /**
   * 🔴 **空振り防止** ── 受け手は全員 `arg` を持つ(`classify()` が
   * 割り当て漏れを `N` で埋め、幽霊を投げて止める)。
   * ⚠ ここが無いと、突き合わせの綴りを 1 文字間違えただけで**全件 `null`** になり、
   *   「仕分けできていない」ではなく「**仕分けの対象が無い**」に見える。
   */
  const nullArg = rows.filter((r) => r.receiver && r.arg === null);
  if (nullArg.length > 0) {
    throw new Error(`受け手なのに種別が付いていない: ${nullArg.length} 件(例 ${nullArg[0].id})`);
  }
  const reg = registries();
  const bookIds = new Set(rows.filter((r) => r.books.length > 0).map((r) => r.id));
  return {
    total: rows.length,
    receivers: rows.filter((r) => r.receiver).length,
    registered: bookIds.size,
    both: rows.filter((r) => r.receiver && r.books.length > 0).length,
    /**
     * 🔴 **`binder.ts` の `ACTIONS` 表に**居ない**登記済み id**。
     *
     * ⚠ **「押す口が無い」ではない。** これらは別の口で撃たれている ──
     *   専用の listener(`toggle-sidebar` / `open-settings`)や、鍵の実行器
     *   (`format-bold` / `undo`)。⚠ 名前を `keyOnly` にしていたが**嘘**だった
     *   (`toggle-sidebar` にはボタンが在る)。
     * 🔑 だから**出口の有無は `screens` で見る**。ここが数えているのは
     *   「受け手の表に居るか」だけである。
     */
    outsideActionsTable: rows
      .filter((r) => !r.receiver && r.books.length > 0)
      .map((r) => ({ id: r.id, bridge: r.bridge })),
    /**
     * 🔴 **登記済みなのに、押し所へ辿る道がこの走査から見えないもの。**
     * ⚠ 「押せない」ではない(専用の listener で受けている物が居る)──
     *   **台帳から追えない**という意味であり、R7 の検査を書く前に
     *   ここを 0 にするか、名指しで既知にする必要がある。
     */
    unbridged: rows.filter((r) => r.books.length > 0 && r.bridge === null).map((r) => r.id),
    /** 🔴 名前で呼べない操作(どの登記簿にも無い)。 */
    unregistered: rows.filter((r) => r.receiver && r.books.length === 0).length,
    /**
     * 🔴 **出口の走査に何件渡したか**(= 走査の範囲そのもの)。
     *
     * ⚠ これが無いと、上の「混ざり始めたら鳴る」検査は**自分で自分を無効化できる** ──
     *   走査を受け手だけに戻すと、`!receiver && screens>0` は**空虚に真**になり、
     *   検査も一緒に消える(変異試験 M3 が SURVIVED で教えた)。
     * 🔑 だから**範囲を数字で出す**:`total` と一致しなければ、絞られている。
     */
    scanned,
    /** ⚠ 2 つ以上の登記簿に在るもの(= 寄せて消える重複)。 */
    sharedBooks: rows.filter((r) => r.books.length > 1).map((r) => ({ id: r.id, books: r.books })),
    perBook: Object.fromEntries(Object.entries(reg).map(([k, v]) => [k, v.length])),
  };
}

if (process.argv[2] === '--json') {
  console.log(JSON.stringify({ summary: summary(), rows: table() }, null, 2));
} else if (process.argv[1] && process.argv[1].endsWith('operation-table.mjs')) {
  const s = summary();
  console.log(`操作 ${s.total} 件(受け手 ${s.receivers} / 登記 ${s.registered})`);
  console.log(`  両方に在る          : ${s.both}`);
  console.log(`  受け手の表の外      : ${s.outsideActionsTable.length}(うち橋で繋がっている ${s.outsideActionsTable.filter((r) => r.bridge !== null).length})`);
  console.log(`  🔴 台帳から辿れない : ${s.unbridged.length} ${JSON.stringify(s.unbridged)}`);
  console.log(`  未登記(名前で呼べない): ${s.unregistered}`);
  console.log(`  登記簿の内訳        : ${JSON.stringify(s.perBook)}`);
  console.log(`  登記簿をまたぐ id   : ${s.sharedBooks.length} ${JSON.stringify(s.sharedBooks)}`);
}
