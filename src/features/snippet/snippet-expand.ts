/**
 * 🔴 **スニペットの展開**(#196 / B-2。P8 段⑧。user go 2026-08-25)。
 *
 * > user 裁定 2026-08-03「text blaze はフューチャーで一旦保留」→ **2026-08-25 に解除**。
 *
 * ## 何が足りなかったか(着手前の検算)
 *
 * ⚠ #196 の本文「PKC3 に該当機能は 0 件」は**そのままでは正しくない** ──
 * 組み込みの雛形(表 / 図 / コードブロック / リンク)は `FORMAT_OPS` から既に届いている。
 * 🔑 落差は「**user が自分の雛形を持てない**」1 点だけである。
 *
 * ## 記法 ── `${…}`
 *
 * | 書き方 | 挿すとどうなるか |
 * |---|---|
 * | `${date}` | `2026-08-25`(**`YYYY-MM-DD`**。本文の `@` 記法と同じ形) |
 * | `${time}` | `14:30` |
 * | `${datetime}` | `2026-08-25 14:30` |
 * | `${cursor}` | 消えて、そこにカーソルが来る |
 * | `${宛名}` | **そのまま残り、選択される** ── 打てば置き換わる |
 *
 * 🔑 **`$` は PKC-Markdown で未使用**である(`:::math` はブロック記法で、`$…$` の
 * 行内数式は持っていない ── 2026-08-25 に全数 grep で確かめた)。
 * 🔴 そして**展開は挿すときだけ**走る ── 普通のノートに `${date}` と書いても、
 * 描画は 1 バイトも変わらない。⚠ ここが「既に配ってある本文の意味を変えない」の要である。
 *
 * ## 🔴 埋める場所を「印のまま」残す理由
 *
 * ⚠ 素朴な実装は `${宛名}` → `宛名` と剥がして位置を覚えるが、**user が 1 文字打つと
 * 覚えた位置が全部ずれる**(次の `Tab` が別の場所を選ぶ = いちばん静かな壊れ方)。
 * 🔑 だから**印を残したまま選択する** ── 次の場所は**そのつど本文を走査して**探すので、
 * 途中でどれだけ編集されても正しい所へ行く(状態を持たない)。
 * ⚠ 埋めずに飛ばした印は本文に残るが、**それは見えている**ので user が直せる
 * (見えない壊れ方より良い)。
 *
 * 🔑 **pure module**。DOM も時計も知らない ── 「いま」は呼び側が渡す。
 */
import { pad2 } from '@features/datetime/datetime-format';
import { dateKey } from '@features/schedule/month-grid';
import type { TextSelection } from '@features/markdown/text-ops';

/**
 * 🔴 **動的値は 4 つだけ**(設計 §4.6)。
 *
 * ⚠ 計算式・条件分岐・繰り返し・外部連携(Text Blaze の Formula / If / Repeat /
 *   DBSelect …)は**入れない**(「新機能を盛り込みすぎない」)。条件分岐が要るなら
 *   PKC3 は既に `:::if{}` を持っている(こちらは**描画時**)。
 */
export const SNIPPET_VARS = ['date', 'time', 'datetime', 'cursor'] as const;
export type SnippetVar = (typeof SNIPPET_VARS)[number];

/**
 * 印 1 つ。⚠ `${` から `}` まで(**閉じ括弧を含む**)── 選択がこの範囲なので、
 * 打てば印ごと置き換わる。
 */
export interface SnippetSlot {
  readonly start: number;
  readonly end: number;
  /** 中の字(`${宛名}` なら `宛名`)。 */
  readonly label: string;
}

/**
 * 印の網。⚠ **改行を跨がせない**(`[^}\n]`)── 跨がせると、閉じ忘れた `${` が
 * 本文の残り全部を 1 つの印として飲み込む。
 * ⚠ 中身が空(`${}`)は印にしない ── 選んでも何も示さないので、ただの字として残す。
 */
const SLOT_RE = /\$\{([^}\n]+)\}/g;

/** 動的値を字にする。知らない名前は `null`(= 埋める印として扱う)。 */
function valueOf(name: string, now: Date): string | null {
  if (name === 'date') return dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
  if (name === 'time') return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  if (name === 'datetime')
    return `${dateKey(now.getFullYear(), now.getMonth() + 1, now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  // ⚠ `cursor` は**字を持たない**(消えて、そこへカーソルが来る)── 呼び側が別に扱う
  return null;
}

/**
 * 動的値だけ先に埋める(`${cursor}` は消し、その位置を返す)。
 *
 * ⚠ **埋める印(`${宛名}`)には触らない** ── そちらは本文に残したまま選択する
 * (この file の頭の理由)。
 *
 * @returns 置き換えた字と、`${cursor}` が在った位置(無ければ `null`)
 */
export function fillSnippetVars(body: string, now: Date): { text: string; caret: number | null } {
  let out = '';
  let caret: number | null = null;
  let at = 0;
  SLOT_RE.lastIndex = 0;
  for (let m = SLOT_RE.exec(body); m !== null; m = SLOT_RE.exec(body)) {
    const name = m[1]!;
    if (name === 'cursor') {
      out += body.slice(at, m.index);
      // ⚠ **最初の 1 つだけ**を採る(2 つ書かれたら後ろのものは印として残る)
      if (caret === null) caret = out.length;
      else out += m[0];
      at = m.index + m[0].length;
      continue;
    }
    const v = valueOf(name, now);
    if (v === null) continue; // 埋める印 ── そのまま残す
    out += body.slice(at, m.index) + v;
    at = m.index + m[0].length;
  }
  return { text: out + body.slice(at), caret };
}

/** 本文に残っている印を全部拾う(前から順)。 */
export function snippetSlots(text: string): SnippetSlot[] {
  const out: SnippetSlot[] = [];
  SLOT_RE.lastIndex = 0;
  for (let m = SLOT_RE.exec(text); m !== null; m = SLOT_RE.exec(text)) {
    const label = m[1]!;
    // ⚠ 動的値は印ではない(挿した時点で字になっているが、後から手で書かれることもある)
    if ((SNIPPET_VARS as readonly string[]).includes(label)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, label });
  }
  return out;
}

/**
 * 🔴 **次に埋める場所**(`Tab` が呼ぶ)。
 *
 * ⚠ **そのつど走査する**(位置を覚えない)── 覚えると、間に打った 1 文字で全部ずれる。
 * ⚠ 見つからなければ `null` ── 呼び側は **`Tab` を素通しする**(既定の焦点移動が
 *   生きる)。⚠ ここで常に握ると、編集欄から `Tab` で出られなくなる。
 *
 * @param from この位置**以降**で探す(`caret` を渡す)
 */
export function nextSnippetSlot(text: string, from: number): SnippetSlot | null {
  const slots = snippetSlots(text);
  return slots.find((s) => s.start >= from) ?? null;
}

/**
 * 🔴 **スニペットを選択位置へ挿す**。
 *
 * ⚠ 返すのは「新しい本文と新しい選択」だけ ── textarea も DOM も知らない
 * (`text-ops.ts` と同じ作法。だから unit で全部見られる)。
 *
 * 選択の決まりは 3 段:
 * 1. **埋める印が在る** → 最初の 1 つを**選ぶ**(打てば置き換わる)
 * 2. 印は無いが `${cursor}` が在った → そこに**カーソルを置く**
 * 3. どちらも無い → 挿した**後ろ**にカーソルを置く
 */
export function insertSnippet(sel: TextSelection, body: string, now: Date): TextSelection {
  const { text: filled, caret } = fillSnippetVars(body, now);
  const head = sel.text.slice(0, sel.start);
  const tail = sel.text.slice(sel.end);
  const text = head + filled + tail;
  const slot = snippetSlots(filled)[0];
  if (slot !== undefined)
    return { text, start: sel.start + slot.start, end: sel.start + slot.end };
  const at = sel.start + (caret ?? filled.length);
  return { text, start: at, end: at };
}
