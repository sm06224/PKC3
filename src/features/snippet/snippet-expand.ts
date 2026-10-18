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
 * 🔴 **2026-09-06(#707)に、この節は事実と逆になった** ── かつてここには
 * 「**`$` は PKC-Markdown で未使用**である(`$…$` の行内数式は持っていない ──
 * 2026-08-25 に全数 grep で確かめた)」と書いてあり、それが
 * **`${…}` を印のまま残してよい根拠**として読まれていた。
 * 🔑 いまは `$…$` / `$$…$$` が数式である。⚠ ただし**この設計は今も安全である** ──
 * 数式の判定(`features/markdown/math-delims.ts`)が
 * **`$` の直後が `{` なら区切りにしない**(開き・閉じの両方)という門を持つので、
 * `${date}` も `${宛名}` も数式として飲まれない。
 * ⚠ **その門を外すと、ここが静かに壊れる** ── 雛形を使う人の本文だけが、
 * 印の間を数式として飲まれる(`math-delims.test.ts` がその形を留めている)。
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
import { lineBreaksAround, type TextSelection } from '@features/markdown/text-ops';
import { fenceStep } from '@features/markdown/list-renumber';

/**
 * 🔴 **動的値は 4 つだけ**(設計 §4.6)。
 *
 * ⚠ 計算式・条件分岐・繰り返し・外部連携(Text Blaze の Formula / If / Repeat /
 *   DBSelect …)は**入れない**(「新機能を盛り込みすぎない」)。条件分岐が要るなら
 *   PKC3 は既に `:::if{}` を持っている(こちらは**描画時**)。
 */
export const SNIPPET_VARS = ['date', 'time', 'datetime', 'cursor'] as const;

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
const SLOT_RE = /[$＄][{｛]([^}｝\n]+)[}｝]/g;

/**
 * 🔴 **全角で打った `＄｛date｝` も同じ印として読む**(#1163 依頼 152。Gemini 回答は案どおり)。
 * 日本語入力のまま打つと `＄｛date｝` になり、効かない理由に気づきにくい。印の字は 1 字 → 1 字なので位置はずれない。
 * ⚠ 動的値の名前(`date` / `ｄａｔｅ`)の比べ方は NFKC に揃える。埋める印の中身(`＄｛宛名｝` の `宛名`)は user の字のまま残す。
 */
function slotName(raw: string): string {
  return raw.normalize('NFKC');
}

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
 * 🔴 **`\${date}` は字のまま `${date}` を出す**(台帳 #1852 束 R1、依頼 273 A)。直前の `\` を 1 つ外して印ごと残す
 *   (変数の `\{{vars.x}}` と同じ作法)。`\\${date}`(逃がした `\` の後ろ)は逃がしではない ── `\` が奇数個のときだけ。
 *   外した印は `literals` に位置を返す ── 挿した後に「埋める場所」として選ばない。
 *
 * @returns 置き換えた字と、`${cursor}` が在った位置(無ければ `null`)と、字のまま残した印の範囲
 */
export function fillSnippetVars(
  body: string,
  now: Date,
): { text: string; caret: number | null; literals: Array<[number, number]> } {
  let out = '';
  let caret: number | null = null;
  const literals: Array<[number, number]> = [];
  let at = 0;
  /**
   * 🔴 **コードの中(囲み・文中コード)の `${…}` は値にしない**(#1087)── user が書いたコードの
   *   `${date}` を挿した日の字に焼き付けない。`nextSnippetSlot` と同じ範囲の決め方(`fenceRegions` /
   *   `inlineCodeRegions`)を使う(§7 判定を 1 つに)。
   */
  let regions: Array<[number, number]> | null = null;
  const inCode = (i: number): boolean => {
    regions ??= [...codeRegions(body), ...blockCodeRegions(body)];
    return regions.some(([a, b]) => i >= a && i <= b);
  };
  SLOT_RE.lastIndex = 0;
  for (let m = SLOT_RE.exec(body); m !== null; m = SLOT_RE.exec(body)) {
    const name = slotName(m[1]!);
    if (inCode(m.index)) continue;
    // 🔴 直前の `\` が奇数個 = 逃がされている ── `\` を 1 つ外して、印をそのまま残す
    let slashes = 0;
    for (let k = m.index - 1; k >= at && body[k] === '\\'; k--) slashes++;
    if (slashes % 2 === 1) {
      out += body.slice(at, m.index - 1);
      literals.push([out.length, out.length + m[0].length]);
      out += m[0];
      at = m.index + m[0].length;
      continue;
    }
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
  return { text: out + body.slice(at), caret, literals };
}

/** 本文に残っている印を全部拾う(前から順)。 */
export function snippetSlots(text: string): SnippetSlot[] {
  const out: SnippetSlot[] = [];
  SLOT_RE.lastIndex = 0;
  for (let m = SLOT_RE.exec(text); m !== null; m = SLOT_RE.exec(text)) {
    const label = m[1]!;
    // ⚠ 動的値は印ではない(挿した時点で字になっているが、後から手で書かれることもある)
    if ((SNIPPET_VARS as readonly string[]).includes(slotName(label))) continue;
    out.push({ start: m.index, end: m.index + m[0].length, label });
  }
  return out;
}

/**
 * 🔴 **コードの塊の中の印は、近くに居ないと `Tab` を取らない**(#1166)。
 *
 * ⚠ 印の探索は**本文の全部**を前へ向かって見る ── だから 500 字先の ``` の中に
 *   `${HOME}`(シェルや JS のテンプレートリテラル。**普通に書く字**)があると、
 *   リストの行でも段落でも **`Tab` が毎回そこへ飛び**、字下げも焦点移動も二度と効かない。
 * 🔑 規則は「**fenced code の中の印は、caret が同じ塊の中に居るか、近く
 *   (`FENCED_SLOT_REACH` 字以内)に在るときだけ印として数える**」の 1 つ。
 *   - 塊の**外**の印は従来どおり(離れていても飛ぶ)── 長い雛形の 2 つ目の欄を殺さない
 *   - 雛形が塊を含むとき(`題 ${題}` の直後に ``` + `${本文}`)は**近い**ので飛べる
 *   - ⚠ 状態は持たない(「いま展開した雛形の範囲」を覚えると、間に打った字で全部ずれる ──
 *     この file の頭の理由)。距離だけで決める
 */
export const FENCED_SLOT_REACH = 200;

/** fenced code の塊(開く行の頭 〜 閉じる行の終わり)。閉じなければ本文の終わりまで。 */
function fenceRegions(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let fence = '';
  let open = 0;
  let at = 0;
  for (const line of text.split('\n')) {
    const st = fenceStep(fence, line);
    const after = st.next;
    // 入れ物が終わって打ち切られた行は、前の fence の外(塊は前の行で終わる)。同じ行が新しい開きかもしれない
    if (fence !== '' && !st.inside) out.push([open, at - 1]);
    if ((fence === '' || !st.inside) && after !== '') open = at;
    if (fence !== '' && st.inside && after === '') out.push([open, at + line.length]);
    fence = after;
    at += line.length + 1;
  }
  if (fence !== '') out.push([open, text.length]);
  return out;
}

/** 柵と文中コードの範囲(印を「コードの中」として扱う範囲の正本。`Tab`・挿入後の選択・値の埋めが同じ答えを返す)。 */
function codeRegions(text: string): Array<[number, number]> {
  return [...fenceRegions(text), ...inlineCodeRegions(text)];
}

/**
 * 値を埋めない範囲の足し分(柵・文中コードの外にある、コードや数式の塊)。
 *
 * - 字下げ 4 つ以上のコード(前が空行 / 本文の頭 / 続きの字下げ行。リストの続きの字下げは除く)
 * - `$$` だけの行で開閉する数式(閉じなければ本文の終わりまで)
 * - `<pre>` 〜 `</pre>`(閉じなければ本文の終わりまで)
 */
function blockCodeRegions(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  let prevBlank = true;
  let inIndented = false;
  let inList = false;
  let math = -1;
  for (const line of text.split('\n')) {
    const end = at + line.length;
    const blank = line.trim() === '';
    if (math >= 0) {
      if (line.trim() === '$$') {
        out.push([math, end]);
        math = -1;
      }
    } else if (/^ {0,3}\$\$\s*$/.test(line)) {
      math = at;
    } else if (/^( {4}|\t)/.test(line) && !blank && (prevBlank || inIndented) && !inList) {
      out.push([at, end]);
      inIndented = true;
    } else {
      if (!blank) {
        inIndented = false;
        inList = /^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(line) || (inList && /^\s/.test(line));
      }
    }
    prevBlank = blank;
    at = end + 1;
  }
  if (math >= 0) out.push([math, text.length]);
  for (const m of text.matchAll(/<pre[\s>][\s\S]*?(?:<\/pre>|$)/gi)) {
    out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}

/**
 * 文中のコード(`` `…` ``)の範囲(開く ` の位置 〜 閉じる ` の終わり)。
 *
 * ⚠ **行の中だけで閉じるものを数える**(閉じなければ文中コードではない ── 本文の ` 1 つで
 *   以後の全部を塊にしない)。長さの違う ` の並びは閉じにならない(CommonMark と同じ)。
 * ⚠ 柵の中の行も同じ走り方をしてよい ── 行の中で閉じる組は柵の範囲の内側に収まるので、
 *   `nextSnippetSlot` が先に柵(`fenceRegions`)に当てて答えは変わらない。
 */
function inlineCodeRegions(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const lineStart = at;
    at += line.length + 1;
    if (!line.includes('`')) continue;
    let open: { idx: number; len: number } | null = null;
    for (const m of line.matchAll(/`+/g)) {
      const idx = m.index!;
      const len = m[0].length;
      if (open === null) open = { idx, len };
      else if (open.len === len) {
        out.push([lineStart + open.idx, lineStart + idx + len]);
        open = null;
      } else if (open.len < len) {
        // 長いほうの並びは、前の開きの閉じにならない ── その並びを新しい開きにする
        open = { idx, len };
      }
    }
  }
  return out;
}

/**
 * 🔴 **次に埋める場所**(`Tab` が呼ぶ)。
 *
 * ⚠ **そのつど走査する**(位置を覚えない)── 覚えると、間に打った 1 文字で全部ずれる。
 * ⚠ 見つからなければ `null` ── 呼び側は **`Tab` を素通しする**(既定の焦点移動が
 *   生きる)。⚠ ここで常に握ると、編集欄から `Tab` で出られなくなる。
 * ⚠ コードの塊の中の印は `FENCED_SLOT_REACH` の規則で絞る(上)。
 * 🔑 **文中のコード(`` `${HOME}` ``)も同じ規則**で絞る ── シェルや JS の `${…}` は
 *   段落の中にも普通に書くので、塊だけを例外にすると、文中の 1 語に `Tab` が毎回飛ぶ。
 *
 * @param from この位置**以降**で探す(`caret` を渡す)
 */
export function nextSnippetSlot(text: string, from: number): SnippetSlot | null {
  const slots = snippetSlots(text);
  let regions: Array<[number, number]> | null = null;
  for (const s of slots) {
    if (s.start < from) continue;
    if (regions === null) {
      regions = codeRegions(text);
    }
    const r = regions.find(([a, b]) => s.start >= a && s.start <= b);
    if (r === undefined) return s;
    if (from >= r[0] && from <= r[1]) return s;
    if (s.start - from <= FENCED_SLOT_REACH) return s;
  }
  return null;
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
export function insertSnippet(
  sel: TextSelection,
  body: string,
  now: Date,
  opts: { breakLines?: boolean } = {},
): TextSelection {
  const { text: filled, caret, literals } = fillSnippetVars(body, now);
  let lead = '';
  let tailBreak = '';
  // 🔴 複数行のテンプレートを一覧から選んだときだけ、行の途中なら改行して挿す(表・見出しは行頭でないと描かれない)。
  //   ⚠ 短縮語 + Tab の経路は呼び側が渡さない(打っている字の続きに挿す)
  if (opts.breakLines === true && filled.replace(/\n+$/, '').includes('\n')) {
    const b = lineBreaksAround(sel.text, sel.start, sel.end);
    lead = filled.startsWith('\n') ? '' : b.lead;
    tailBreak = filled.endsWith('\n') ? '' : b.tail;
  }
  const head = sel.text.slice(0, sel.start);
  const tail = sel.text.slice(sel.end);
  const text = head + lead + filled + tailBreak + tail;
  const base = sel.start + lead.length;
  // ⚠ コードの中の印は選ばない(`fillSnippetVars` が値にしない範囲と同じ: 柵・文中コード + 字下げのコード・`$$`・`<pre>`)
  //   ── `${HOME}` より `${cursor}` を優先する。`\${…}` で字のまま残した印も選ばない(依頼 273 A)
  const regions = [...codeRegions(filled), ...blockCodeRegions(filled), ...literals];
  const slot = snippetSlots(filled).find((s) => !regions.some(([a, b]) => s.start >= a && s.start <= b));
  if (slot !== undefined) return { text, start: base + slot.start, end: base + slot.end };
  const at = base + (caret ?? filled.length);
  return { text, start: at, end: at };
}
