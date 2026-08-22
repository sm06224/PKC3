/**
 * YAML mini frontmatter parser (領域 10-6 ζ'' Phase 2a + reform-2026-05 Phase 1 PR-B 拡張).
 *
 * Pure TypeScript, dep-zero. Supports the subset that book / youtube /
 * album / paper / film entries actually need:
 *
 *   - Document fence: `---\n…\n---\n` at byte 0 of body
 *   - Flat key:value pairs, one per line
 *   - Values inferred as `string | number | boolean | null` plus
 *     scalar arrays (`[a, b, c]` / next-line `- a` block)
 *   - Quoted strings (single, double) keep their literal content
 *
 * Out of scope (returns the body untouched if encountered):
 *   - Nested mappings (key with `:\n  child:` indented children)
 *   - Anchors / aliases / merge keys
 *   - Complex multiline scalars (`|`, `>`)
 *   - Type tags (`!!str`)
 *
 * reform-2026-05 Phase 1 PR-B 追加:
 *   - **size cap**:`features/notation/caps.ts` の `resolveCap('frontmatter', 'bytes')`
 *     を使って input size 上限 enforcement(default 16 KB、HARD ceiling 1 MB)。
 *     超過時は warnings に push、parse 中止して body だけ返す。
 *   - **warnings field**:silent fail を避けるため、cap overflow 等を
 *     `result.warnings` に貯める(spec §07.3 silent fail 禁止)。
 *
 * Spec: PKC2: docs/development/filer-view-and-folder-display-profile-audit-2026-05.md §2.4
 *       PKC2: docs/development/notation-redesign-2026-05/02-frontmatter-and-globals.md §2.5
 */

import { resolveCap } from '../notation/caps';

export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | Array<string | number | boolean | null>;

export interface FrontmatterWarning {
  /** 警告の分類。CSS / display 振り分け用、reform spec §07.3 と整合。 */
  kind: 'size_limit' | 'malformed' | 'forbidden_key' | 'duplicate_key';
  /** Human-readable Japanese reason、可視 warning に流す。 */
  detail: string;
}

export interface FrontmatterResult {
  /** Parsed key/value pairs. Empty object when no frontmatter detected. */
  meta: Record<string, FrontmatterValue>;
  /** Original body with the fenced frontmatter removed (if any). */
  body: string;
  /**
   * `true` when an opening `---` was found AND a matching closing `---`
   * was also found. `false` keeps `body` identical to the input.
   */
  found: boolean;
  /**
   * Soft warnings emitted during parse(reform-2026-05 PR-B 追加)。
   * cap 超過 / forbidden key / 重複 key 等。空配列 = clean parse。
   * caller は inspector / preview 先頭で `<div class="pkc-frontmatter-warning">`
   * として表示する想定(spec §07.3、silent fail 禁止)。
   */
  warnings: FrontmatterWarning[];
}

const OPEN_FENCE = /^---\s*\r?\n/;
const CLOSE_FENCE_LINE = /^---\s*$/;

/** UTF-8 byte length。cap enforcement の size 計測に使う。 */
function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).length;
  }
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

/**
 * 🔴 **先頭の frontmatter が占める「行数」**(#284)。閉じの `---` の行まで含む。
 * frontmatter が読めないとき(開きだけ / そもそも無い)は **0**。
 *
 * ## なぜ `parseFrontmatter().body` の行数差で数えないか
 *
 * ⚠ `parseFrontmatter` が返す `body` は **CRLF を LF へ正規化**し、さらに
 *   閉じの直後の**空行を 1 行食べる**(`remainder.startsWith('\n')` の枝)──
 *   差分で数えると **1 行ずれる**ことがあり、そのずれは
 *   「行ごとの編集が 1 行上を書き換える」という**静かなデータ破壊**になる。
 * 🔑 だから**原文の物理行**をここで数え、切るのも呼び側で
 *   `split('\n').slice(n)` に統一する(規則を 2 つ作らない)。
 */
export function frontmatterLineCount(body: string): number {
  if (!body) return 0;
  const open = OPEN_FENCE.exec(body);
  if (open === null) return 0;
  // ⚠ 開きは `---\s*\r?\n` ── 直後が空行なら改行を 2 つ飲んでいる
  const openLines = (open[0].match(/\n/g) ?? []).length;
  const lines = body.replace(OPEN_FENCE, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (CLOSE_FENCE_LINE.test(lines[i] ?? '')) return openLines + i + 1;
  }
  return 0;
}

/**
 * 閉じの `---` が無いとき、**frontmatter として読める行が先頭から何行続くか**を返す
 * (#284 / #318)。`0` なら「ただの水平線で始まる普通の文書」。
 *
 * ⚠ 見分けずに警告すると、`---` で始まる普通の文書が取込のたびに警告を出す
 *   ── 警告が常在すると、本物の警告がそこに紛れる(CLAUDE.md「stderr は 0 行を保つ」
 *   と同じ理屈)。
 * 🔴 **走の文法は `parseFlatYaml` に合わせる**(着地前レビュー B / C / D)。
 *
 * ⚠ 1 稿目はここに**独自の文法**(「`key:` の行 + それに続く**字下げ**の行」)を
 *   書いた。読み手と別の文法だったので、**user のデータが 4 通りに変質した**
 *   ── どれも実測で再現した:
 *
 * | 本文 | 1 稿目がやったこと |
 * |---|---|
 * | `---\ntags:\n- あ\n- い\n本文` | 字下げ**無し**の配列を続きと見ず、`tags: []` にして**中身を本文へ落とした** |
 * | `---\n# メモ\ntags: [あ]\n本文` | コメントで走が 0 になり、**二重 fence をそのまま作った**(#318 が直っていない) |
 * | `---\ntags: [あ]\n# メモ\npriority: high` | コメントで走が切れ、**`priority` を本文へ追い出した** |
 * | `---` + `tags: [あ]` + **全角空白で字下げした段落** | その段落を frontmatter へ飲み、本文から消した |
 *
 * ⚠ しかも「字下げの続き」を守っていたはずの `last === i - 1` は **到達時に常に真**
 *   ── 何も守っていない **no-op** だった(28,561 形の差分で 0 件。CLAUDE.md
 *   「これが無いと壊れると書いた規則が no-op だった」の 3 度目)。
 *
 * 🔑 だから **`parseFlatYaml` が実際に読む形だけ**を走に入れる:
 *   ① `key: …` の行(字下げの有無を問わない ── あちらは `slice(0, colon).trim()`)
 *   ② **値の無い key に続く `- item`**(字下げの有無を問わない ── あちらは `/^\s*-\s+/`)
 *   ③ `#` で始まるコメント行 ── ⚠ **後ろに key が来るときだけ**(`last` を進めない)。
 *      進めると `---\n# 見出し\n本文` という**水平線 + markdown 見出し**を
 *      frontmatter と読む。
 * ⚠ 空行では切る(保守的)── frontmatter の中の空行は `parseFlatYaml` が読み飛ばすが、
 *   ここで跨ぐと「水平線 + 散文」を飲み込む側の誤りが増える。
 *
 * 🔴 **答えを 1 か所にする**(CLAUDE.md §7)。この関数の答えは 2 か所で使う ──
 * ① `parseFrontmatter` が「読めていない」と**警告を出すか**
 * ② `spliceFrontmatterKeys` が「閉じを補って直すか、fence を前置するか」
 * ⚠ 別々に数えると、**警告は出さないのに書込は壊す**(あるいはその逆)という
 *   食い違いができる ── #318 はその食い違いそのものだった。
 *
 * ⚠ **key の見分けは `parseFlatYaml` と同じ規則にする**(`^[A-Za-z_][\w.-]*$`)。
 *   直す前はここだけ `^[A-Za-z0-9_.-]+$` で**数字始まりを許して**いたので、
 *   `12:30 に集合` という普通の 1 行が「壊れた frontmatter」に見えていた
 *   ── 読み手が読まない形を、検出器だけが frontmatter と呼んでいた。
 */
function frontmatterRunLength(lines: readonly string[]): number {
  /** 走に入っている最後の**実のある**行(コメントでは進めない)。 */
  let last = -1;
  /** 直前が「値の無い key」または「その続きの `- item`」か(ブロック配列の中)。 */
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    /**
     * 🔴 **空行でも切らない**(2 巡目レビュー A-1)。
     *
     * ⚠ 1 稿目・2 稿目はここで `break` していたが、`parseFlatYaml` は
     *   **空行を読み飛ばして先を読む** ── つまり
     *   `---\ntitle: メモ\n\ntags: [買い物]\n---\n本文` は**今日の正規の frontmatter**
     *   である。閉じを失ったこの本文を「修理」すると、閉じが `title:` の直後に入り、
     *   **`tags` が読めない側へ落ちた**。
     * ⚠ そのうえ落ちた後は `frontmatterProblem` が `null` を返すので、
     *   **警告まで消える** ── user から見ると「警告が出ていた → チェックを付けた →
     *   警告が消えた」なので **直ったと読む**。**アプリ自身の修理が嘘を作っていた**。
     * 🔑 空行はコメントと同じ扱いにする(`last` を進めない)── 後ろに key が
     *   来るときだけ跨ぐので、`---\nk: 1\n\n散文です\nk2: 2` は走 1 行のまま。
     */
    if (line.trim() === '') continue;
    // ③ コメント ── 後ろに key が来れば `last` が追い越すので、自然に含まれる
    if (line.trimStart().startsWith('#')) continue;
    const colon = findKeyColon(line);
    if (colon > 0 && /^[A-Za-z_][\w.-]*$/.test(line.slice(0, colon).trim())) {
      last = i;
      inBlock = line.slice(colon + 1).trim() === '';
      continue;
    }
    // ② ブロック配列の項目。⚠ 字下げの有無を問わない(`parseFlatYaml` と同じ)
    if (inBlock && /^\s*-\s+/.test(line)) {
      last = i;
      continue;
    }
    break;
  }
  return last + 1;
}

/**
 * 🔴 **文書の情報にまつわる「言うべきこと」**(#284 / #318)。無ければ `null`。
 *
 * ## なぜ要るか
 *
 * `parseFrontmatter` は読めないとき `found: false` を返すが、それは
 * **「そもそも書いていない文書」と同じ答え**である ── 画面側はその 2 つを
 * 区別できないので、情報ペインは壊れた本文にも「タグ **無し**」と**断定して
 * 嘘をつく**(その数行上の「本文未読では嘘を書かない」は守られているのに、
 * **対称の反対側だけ空いていた**)。
 *
 * ## 🔴 **種別を持つ**(2 巡目レビュー A-2)
 *
 * ⚠ 1 稿目は 3 つの**別々の事実**を同じ `string` 1 本で返していた:
 *
 * | 事実 | 1 本目は読めるか |
 * |---|---|
 * | `malformed`(閉じが無い) | ❌ 読めない |
 * | `size_limit`(cap 超過) | ❌ 読めない(`meta` が空) |
 * | **2 組目らしきものが本文の先頭にある** | ✅ **完全に読める** |
 *
 * 呼び側は「`problem !== null` なら読めていない」と扱うので、**3 つ目でも
 * 1 つ目と同じ扱い**になっていた ── 健全なノート(`---` + `title:` + `---` の後に
 * 区切り線と `TODO:` が続くだけ)で、情報ペインが**実在するタグを隠し**、
 * 1 面編集の札が**唯一の編集の口を消して**いた(#284 の嘘の裏返しを、こちらで作っていた)。
 *
 * 🔑 だから `kind` を返す:`unreadable` だけが要約とタグを止め、`trailing` は
 *   **要約・編集・タグをそのまま出したうえで理由を添える**。
 *
 * ⚠ **`warnings` の消費者が皆無というわけではない** ── 取込(`plain-markdown.ts`)と
 *   書き出し(`pkc3-markdown-zip.ts`)は既に読んでいる。無いのは**画面側の出口**だった。
 * ⚠ その 2 つは `trailing` を見ない(データは byte 無傷で通るので実害が無く、
 *   「parse の警告」ではないものを警告欄へ混ぜない)── 意図した境界である。
 *
 * 🔑 判定を**ここ 1 か所**に置く(§7)── 画面ごとに `warnings.some(...)` を
 *   書くと、`kind` を足したとき片方だけ拾う。
 */
export interface FrontmatterProblem {
  /** `unreadable` = 1 本目が読めない / `trailing` = 1 本目は読めるが、本文の先頭にもう 1 組ある。 */
  kind: 'unreadable' | 'trailing';
  /** 画面にそのまま出す 1 行。⚠ **user の言葉**で書く(内部語を出さない)。 */
  detail: string;
}

export function frontmatterProblem(body: string): FrontmatterProblem | null {
  const r = parseFrontmatter(body);
  /**
   * 🔴 **`meta` を空にする warning は 1 か所に列挙する**(1 巡目レビュー E)。
   * ⚠ 1 稿目は `malformed` しか見ていなかったので、**cap 超過のノートで
   *   #284 の嘘がそのまま残っていた**。
   * 🔑 書き出し側は既に正しく扱っている(`pkc3-markdown-zip.ts` の `blind`)──
   *   **同じ問いに 2 つ目の答えが既に在り、新しい関数がそれと食い違っていた**。
   */
  if (r.warnings.some((x) => x.kind === 'malformed')) {
    return {
      kind: 'unreadable',
      detail: '先頭の --- に対応する閉じの --- がありません(文書の情報として読めていません)',
    };
  }
  /**
   * ⚠ **画面へ出す字は、この面の言葉で書く**(2 巡目レビュー B-5)。
   *   `warnings` の `detail` は書き出しの log 用で「frontmatter サイズが 16384 bytes を
   *   超過(…)、parse 中止」── 製品はこの領域を一貫して「**この文書の情報**」と
   *   呼んでいるのに、ここだけ内部語だった(**画面へ出す口が増えたのに文面を
   *   見直していなかった**)。
   */
  if (r.warnings.some((x) => x.kind === 'size_limit')) {
    return {
      kind: 'unreadable',
      detail: 'この文書の情報が大きすぎて読み取れませんでした(減らすと読めるようになります)',
    };
  }
  /**
   * 🔴 **既に二重 fence になっている本文も拾う**(#318 の「対で塞ぐもの」)。
   * ⚠ 二重 fence は 1 本目が正しく読めてしまうため `warnings` が **0 件**になる。
   * 🔑 だから **読めた残り(`r.body`)をもう一度見る**。
   * ⚠ **1 段だけ見る**(3 組目は追わない)── 深追いしても言えることが増えない。
   * ⚠ **断定しない**(1 巡目レビュー F)── `---` + `Note: …` で始まる**普通の本文**でも
   *   同じ形になる。断定されると user は**存在しない 2 組目を探して本文を消しにいく**。
   */
  if (r.found) {
    const rest = parseFrontmatter(r.body);
    if (rest.warnings.some((x) => x.kind === 'malformed')) {
      return {
        kind: 'trailing',
        detail:
          '本文の先頭が --- で始まっていて、2 組目の文書の情報として読める形になっています(上の情報は読めています)',
      };
    }
  }
  return null;
}

/**
 * Split a body into its frontmatter block and the markdown remainder.
 * Always returns a defined result; on parse failure the meta is empty
 * and body is the original input.
 */
export function parseFrontmatter(body: string): FrontmatterResult {
  const warnings: FrontmatterWarning[] = [];
  const emptyMeta: Record<string, FrontmatterValue> = {};
  if (!body || !OPEN_FENCE.test(body)) {
    return { meta: emptyMeta, body, found: false, warnings };
  }
  // Strip the opening `---\n`.
  const afterOpen = body.replace(OPEN_FENCE, '');
  const lines = afterOpen.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CLOSE_FENCE_LINE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    /**
     * 🔴 **黙って通さない**(#284)。⚠ ここは `found: false` を返すので、
     * 呼び側から見ると「frontmatter が無い文書」と**区別が付かない** ── 実測では
     * 閉じの `---` を 1 行消しただけで `meta` が `{}` になり、**警告も 0 件**だった
     * (タグを付けたノートで、タグが警告なしに全部消える経路)。
     *
     * ⚠ この file には silent fail 禁止の仕組み(`warnings`)が在るのに、
     *   **この経路だけ 1 件も積んでいなかった**。
     * ⚠ 先頭が水平線(`---`)の普通の文書もここへ来る ── だから**投げない**
     *   (soft warning のまま)。呼び側が「情報として読めていない」と言えればよい。
     */
    /**
     * 🔴 **「開きの直後が空行なら水平線」という除外を落とした**(#284、2026-08-22)。
     *
     * ⚠ その除外は**parse の規則と食い違っていた**。実測:
     *
     * | 本文 | `parseFrontmatter` の答え |
     * |---|---|
     * | `---\n\ntags: [あ]\n---\n本文` | `found: true` / `meta: {tags:['あ']}` ← **正規に読める** |
     * | `---\n\ntags: [あ]\n本文` | `warnings: []` ← **完全に無言** |
     *
     * つまり **読めると認めている形なのに、閉じを失ったときだけ黙って**いた。
     * ⚠ 除外の理由づけ(「`OPEN_FENCE` が空行まで飲むので水平線と区別できない」)は
     *   正しかったが、**同じ理屈が正規の経路にも効いている** ── `\s*` が空行を飲むから
     *   こそ、閉じさえ在れば `tags:` は frontmatter として読まれる。片側だけ除外すると
     *   「読めるのに、壊れたときは黙る」になる。
     * 🔑 水平線との切り分けは `frontmatterRunLength` に寄せた(`key:` の行が
     *   1 つも無ければ 0 = 警告しない)。
     */
    if (frontmatterRunLength(lines) > 0) {
      warnings.push({
        kind: 'malformed',
        detail: '先頭の --- に対応する閉じの --- がありません(文書の情報として読めていません)',
      });
    }
    return { meta: emptyMeta, body, found: false, warnings };
  }

  const yamlLines = lines.slice(0, closeIdx);

  // reform-2026-05 PR-B:size cap 適用(SOFT_DEFAULTS 16 KB、HARD 1 MB)。
  // 超過時は parse 中止 + 可視 warning(spec §07.3 silent fail 禁止)。
  const fmText = yamlLines.join('\n');
  const fmBytes = byteLength(fmText);
  const sizeCap = resolveCap('frontmatter', 'bytes');
  if (fmBytes > sizeCap) {
    warnings.push({
      kind: 'size_limit',
      detail: `frontmatter サイズが ${sizeCap} bytes を超過(${fmBytes} bytes)、parse 中止`,
    });
    const remainder = lines.slice(closeIdx + 1).join('\n');
    return {
      meta: emptyMeta,
      body: remainder.startsWith('\n') ? remainder.slice(1) : remainder,
      found: true,
      warnings,
    };
  }

  const meta = parseFlatYaml(yamlLines);
  const remainder = lines.slice(closeIdx + 1).join('\n');
  return {
    meta,
    body: remainder.startsWith('\n') ? remainder.slice(1) : remainder,
    found: true,
    warnings,
  };
}

/**
 * 行末 `# comment` を除去する(YAML 慣例: `#` の直前に空白があるときのみ)。
 * ⚠ PKC2 版は `/\s+#.*$/` の一括 replace で **quote 内の `#` まで切り落として
 * いた**(serializeFrontmatter が quote した値が parse で壊れる round-trip バグ)。
 *
 * PKC3 の意味論(parseVarValue / 実 YAML と同じ):**値の先頭が quote 文字の
 * ときだけ** quote を追跡する。plain scalar 中の `'`(例: `title: it's a pen`)
 * は quote 開始ではないので、素朴な行末コメント除去に落ちる(P3-4 review #4)。
 */
function stripTrailingComment(line: string): string {
  const colon = findKeyColon(line);
  let i = colon >= 0 ? colon + 1 : 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  const q = line[i];
  if (q === '"' || q === "'") {
    // 閉じ quote を探す(double は `\` escape、single は `''` escape)
    let j = i + 1;
    while (j < line.length) {
      const ch = line[j];
      if (q === '"' && ch === '\\') {
        j += 2;
        continue;
      }
      if (ch === q) {
        if (q === "'" && line[j + 1] === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j += 1;
    }
    if (j >= line.length) return line.trimEnd(); // 非終端 quote は触らない
    const rest = line.slice(j + 1);
    const m = /\s#/u.exec(rest);
    if (m) return line.slice(0, j + 1 + m.index).trimEnd();
    return line.trimEnd();
  }
  if (q === '[') {
    // inline 配列: 要素が quote されうる(serializeScalar)ので quote 外の
    // 空白+`#` だけをコメントと見なす
    let inSingle = false;
    let inDouble = false;
    for (let j = i; j < line.length; j++) {
      const ch = line[j];
      if (ch === '\\' && inDouble) {
        j += 1;
        continue;
      }
      if (!inDouble && ch === "'") inSingle = !inSingle;
      else if (!inSingle && ch === '"') inDouble = !inDouble;
      else if (!inSingle && !inDouble && ch === '#' && /\s/u.test(line[j - 1]!)) {
        return line.slice(0, j).trimEnd();
      }
    }
    return line.trimEnd();
  }
  return line.replace(/\s+#.*$/u, '').trimEnd();
}

function parseFlatYaml(lines: readonly string[]): Record<string, FrontmatterValue> {
  const out: Record<string, FrontmatterValue> = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    i += 1;
    const line = stripTrailingComment(raw);
    if (line.trim() === '') continue;
    if (line.startsWith('#')) continue;

    const colon = findKeyColon(line);
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    if (!key || !/^[A-Za-z_][\w.-]*$/.test(key)) continue;
    const valuePart = line.slice(colon + 1).trim();

    if (valuePart === '') {
      // Could be a block-style array on subsequent indented lines.
      const arr: Array<string | number | boolean | null> = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        const m = /^\s*-\s+(.*)$/u.exec(next);
        if (!m) break;
        arr.push(parseScalar(m[1]!.trim()));
        i += 1;
      }
      out[key] = arr;
      continue;
    }

    if (valuePart.startsWith('[') && valuePart.endsWith(']')) {
      out[key] = parseInlineArray(valuePart.slice(1, -1));
      continue;
    }

    out[key] = parseScalar(valuePart);
  }
  return out;
}

function findKeyColon(line: string): number {
  // Find the first `:` outside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      i += 1;
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === ':') return i;
  }
  return -1;
}

function parseInlineArray(inner: string): Array<string | number | boolean | null> {
  if (inner.trim() === '') return [];
  // Naive split on commas outside quotes; sufficient for scalars.
  const parts: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      buf += ch + (inner[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
    if (ch === ',' && !inSingle && !inDouble) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => parseScalar(p.trim()));
}

function parseScalar(raw: string): string | number | boolean | null {
  if (raw === '' || raw === '~' || raw === 'null' || raw === 'Null' || raw === 'NULL') return null;
  if (raw === 'true' || raw === 'True' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'False' || raw === 'FALSE') return false;

  // Quoted string — strip quotes, handle a couple of escapes.
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if (first === '"' && last === '"') {
      return raw.slice(1, -1).replace(/\\(["\\nt])/gu, (_m, ch: string) =>
        ch === 'n' ? '\n' : ch === 't' ? '\t' : ch,
      );
    }
    if (first === "'" && last === "'") {
      return raw.slice(1, -1).replace(/''/gu, "'");
    }
  }

  // Numeric? Use JSON.parse for strict number validation.
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }

  // Date-like (YYYY-MM-DD, ISO timestamp) — keep as string. Useful for
  // `read_at: 2024-03-15` etc. without converting to a Date object.
  return raw;
}

/**
 * Public helper: 単一の scalar 文字列(graphical editor の input value 等)を
 * frontmatter 値型に解釈する。`parseFlatYaml` 内の scalar 解釈と同一規則。
 */
export function parseFrontmatterScalar(
  raw: string,
): string | number | boolean | null {
  return parseScalar(raw.trim());
}

/**
 * Public helper: returns the `kind` discriminator if present and valid.
 * Filer subset profiles look this up to decide which entries belong
 * to the `book-base` / `youtube-base` / etc. query.
 */
export function getFrontmatterKind(body: string): string | null {
  const { meta, found } = parseFrontmatter(body);
  if (!found) return null;
  const kind = meta['kind'];
  return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

/**
 * L-? M-7(2026-05-08、wave-10-2 Phase 2):frontmatter から `vars.*` を
 * 抽出して flat `Record<string, string>` に正規化する helper。本文の
 * `{{vars.name}}` 展開で使う(`renderMarkdown(text, { vars })` 経由)。
 *
 * 受理する 2 形式:
 *
 *   1. ネスト object 形式(spec §3.6 例):
 *        vars:
 *          project: ALPHA-7
 *          client: Acme Corp
 *
 *   2. flat dot-notation 形式(YAML 平 parse の延長):
 *        vars.project: ALPHA-7
 *        vars.client: Acme Corp
 *
 * 両形式を併用しても OK(後者が優先される、上書き)。
 *
 * 既存 `parseFrontmatter` は flat 1 階のみ対応で nested object を
 * 解釈しないため、本 helper は raw frontmatter 領域を独自に scan する。
 *
 * 値は string 化して返す(boolean / number は `String()`、null は除外)。
 *
 * frontmatter 不在 / vars 不在 / parse 失敗 → `{}` を返す(safe default)。
 */
export function extractVars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || !OPEN_FENCE.test(body)) return out;
  const afterOpen = body.replace(OPEN_FENCE, '');
  const lines = afterOpen.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CLOSE_FENCE_LINE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return out;
  const frontLines = lines.slice(0, closeIdx);

  // 1. nested object 形式:`vars:` 単独行 + 後続の indented `<key>: <value>` 群
  for (let i = 0; i < frontLines.length; i++) {
    const line = frontLines[i] ?? '';
    if (!/^vars\s*:\s*$/.test(line)) continue;
    // 子行を読み込む。1 文字以上のインデント(SP / TAB)+ key: value 形式。
    let j = i + 1;
    while (j < frontLines.length) {
      const child = frontLines[j] ?? '';
      // 空行は break(ネストブロック終了)
      if (child.trim() === '') break;
      const m = /^(\s+)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(child);
      if (!m) break;  // 非インデント or 不正形式 = nested 終了
      const key = m[2]!;
      const rawVal = m[3]!.trim();
      out[key] = parseVarValue(rawVal);
      j++;
    }
    break;  // vars: ブロックは 1 回だけ
  }

  // 2. flat dot-notation 形式:`vars.X: value`
  for (const line of frontLines) {
    const m = /^vars\.([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rawVal = m[2]!.trim();
    out[key] = parseVarValue(rawVal);
  }

  return out;
}

/** quoted string / scalar を string 化して返す。null は空文字。 */
function parseVarValue(raw: string): string {
  if (raw === '' || raw === '~' || /^null$/i.test(raw)) return '';
  if (raw.length >= 2) {
    const f = raw[0];
    const l = raw[raw.length - 1];
    if (f === '"' && l === '"') {
      return raw.slice(1, -1).replace(/\\(["\\nt])/gu, (_m, ch: string) =>
        ch === 'n' ? '\n' : ch === 't' ? '\t' : ch,
      );
    }
    if (f === "'" && l === "'") return raw.slice(1, -1).replace(/''/gu, "'");
  }
  // trailing # comment を strip(YAML 慣例)
  return raw.replace(/\s+#.*$/u, '').trim();
}

// ── serialize(parseFrontmatter の逆変換、Phase γ-B1)──
//
// graphical frontmatter editor が編集結果を entry.body に書き戻すための pure
// 関数。flat YAML のみ(spec §3.6、nested 非対応)。serialize → parseFrontmatter
// が round-trip するよう、scalar は parseScalar が別型に解釈し得る場合に quote。

// raw 文字列が parseScalar で string 以外 / 構造文字で壊れる場合に quote が要る。
function scalarNeedsQuote(s: string): boolean {
  if (s === '') return true;
  if (s !== s.trim()) return true;
  if (/^(~|null|Null|NULL|true|True|TRUE|false|False|FALSE)$/u.test(s)) return true;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(s)) return true;
  // `,` を含む値は quote 必須 ── inline 配列要素が parseInlineArray の
  // comma split で分裂する(P3-4 review #1: 無言のデータ破損)。scalar 値でも
  // quote は無害なので一律に含める
  if (/[:#"',[\]]/u.test(s)) return true;
  if (s.startsWith('-')) return true;
  if (/[\n\r]/u.test(s)) return true;
  return false;
}

function quoteScalar(s: string): string {
  const escaped = s
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, '\\n')
    .replace(/\t/gu, '\\t');
  return `"${escaped}"`;
}

function serializeScalar(v: string | number | boolean | null): string {
  // null は明示的に `null` と書く。空値 `key:` は parseFlatYaml が block-style
  // 空配列 [] に解釈してしまい round-trip が壊れるため。
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return scalarNeedsQuote(v) ? quoteScalar(v) : v;
}

/**
 * key/value pairs を `---` で挟んだ frontmatter block 文字列に serialize する。
 * 空 meta でも `---\n---` を返す(空 block の判定は呼び出し側 `setFrontmatter`)。
 */
export function serializeFrontmatter(
  meta: Record<string, FrontmatterValue>,
): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(serializeScalar).join(', ')}]`);
    } else {
      lines.push(`${key}: ${serializeScalar(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * body の frontmatter block を `meta` で置き換える(無ければ prepend)。
 * meta が空なら frontmatter を除去した本文のみを返す。
 * ⚠ parse view 経由なので本文先頭の空行 1 個が落ちる既知の癖がある ──
 * **既存 body の部分書換には使わず `spliceFrontmatterKeys` を使う**
 * (P3-4 review #5 の規律: 書換は原文 splice で)。
 */
export function setFrontmatter(
  body: string,
  meta: Record<string, FrontmatterValue>,
): string {
  const { body: rest } = parseFrontmatter(body);
  if (Object.keys(meta).length === 0) return rest;
  const fm = serializeFrontmatter(meta);
  return rest === '' ? fm : `${fm}\n${rest}`;
}

/**
 * frontmatter の特定 key だけを**原文 splice**で書き換える(P3-6、かんばん
 * トグル等の構造化操作用)。本文・他 key・空行・コメントは byte 単位で無傷。
 *
 * - key が既存 → その行だけ差し替え(最初の一致。値 undefined なら行を除去)
 * - key が無い → 閉じ fence の直前に追加
 * - frontmatter 自体が無い → fence を前置(本文は無傷のまま後続)
 */
export function spliceFrontmatterKeys(
  body: string,
  updates: Record<string, FrontmatterValue | undefined>,
): string {
  const entries = Object.entries(updates);
  if (entries.length === 0) return body;
  const lineFor = ([key, value]: [string, FrontmatterValue | undefined]):
    | string
    | null =>
    value === undefined
      ? null
      : Array.isArray(value)
        ? `${key}: [${value.map(serializeScalar).join(', ')}]`
        : `${key}: ${serializeScalar(value)}`;

  if (!OPEN_FENCE.test(body)) {
    const lines = entries.map(lineFor).filter((l): l is string => l !== null);
    if (lines.length === 0) return body;
    return `---\n${lines.join('\n')}\n---\n${body}`;
  }

  const open = body.match(OPEN_FENCE)![0];
  const afterOpen = body.slice(open.length);
  // 行末記号(LF / CRLF)を各行に残したまま分割 ── 本文を byte 無傷で戻すため
  const parts = afterOpen.split(/(?<=\n)/);
  let closeAt = -1;
  for (let i = 0; i < parts.length; i++) {
    if (CLOSE_FENCE_LINE.test((parts[i] ?? '').replace(/\r?\n$/, ''))) {
      closeAt = i;
      break;
    }
  }
  const eol = body.includes('\r\n') ? '\r\n' : '\n'; // 新規行のみに使う
  if (closeAt === -1) {
    /**
     * 🔴 **開きは在るが閉じが無い**(#318)。直す前はここも「frontmatter 不在」と
     * 見なして fence を**前置**していたが、それは user のデータを壊す:
     *
     * ```
     * 元:   ---\ntags: [あ]\n本文…
     * 直前: ---\nstatus: done\n---\n---\ntags: [あ]\n本文…   ← 二重 fence
     * ```
     *
     * ⚠ **そのあとが本当に悪い**(実測)── 二重になると再 parse は
     *   `found: true` / `meta: {status:'done'}` / `warnings: 0 件` を返す。つまり
     *   **user が書いた `tags` は読めない側へ落ちたのに、画面は「読めている」顔をする**。
     *   いちばん壊れた状態で、いちばん安心させる形である。
     * ⚠ 到達経路は**どちらも普通の操作**(カレンダーで日付を付ける / 印を切り替える)。
     *
     * 🔑 だから **閉じを補ってから書く** ── user が書いた key を残す。
     *   補う位置は `frontmatterRunLength`(= 警告を出すかの判定と**同じ 1 つ**)。
     * ⚠ `key:` の行が 1 つも無ければ **ただの水平線で始まる普通の文書**なので、
     *   これまでどおり前置する(本文は byte 無傷のまま後続する)。
     */
    const run = frontmatterRunLength(parts.map((p) => p.replace(/\r?\n$/, '')));
    if (run === 0) {
      const lines = entries.map(lineFor).filter((l): l is string => l !== null);
      if (lines.length === 0) return body;
      return `---\n${lines.join('\n')}\n---\n${body}`;
    }
    /**
     * 🔴 **書くものが何も無いなら、直さない**(着地前レビュー ②)。
     * ⚠ 「無い key を消す」だけの空操作(`{ status: undefined }`)でも修理が走ると、
     *   **user が何もしていないのに文書の見え方が変わる**(水平線に見えていた 2 行が
     *   以後は隠れた「文書の情報」になる)。`store-effects.ts` の
     *   `if (next === body) return fail()` も通り抜けてしまう。
     */
    const willWrite =
      entries.some(([, v]) => v !== undefined) ||
      entries.some(([key]) =>
        parts
          .slice(0, run)
          .some((p) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(p)),
      );
    if (!willWrite) return body;
    /**
     * 🔴 **走の最後の行に改行が無いなら、足してから閉じを挿す**(着地前レビュー A)。
     *
     * ⚠ `parts` は `split(/(?<=\n)/)` なので**最終要素だけ改行を持たない**。
     *   そのまま閉じを挿すと、後続の `fmParts.push(line + eol)` が
     *   **user の行の続きに連結**する ── 実測:
     *   `---\ntags: [あ]`(末尾改行なし)→ `---\ntags: [あ]status: done\n---\n`
     *   → 再 parse は `{tags: "[あ]status: done"}`(**配列が文字列に化ける**)。
     * ⚠ これは**前置していた頃より悪い** ── あちらは行が原文にそのまま残って
     *   復旧できたが、こちらは**行そのものが書き換わる**。
     * 🔑 textarea は Enter を押さない限り末尾改行を持たないので、
     *   「末尾改行の無い本文」は**例外ではなく普通**である。
     */
    // ⚠ `split(/(?<=\n)/)` は末尾に空要素を作らないので、`run > 0` の下で
    //    `parts[run-1]` が空文字になることは無い(2 巡目レビュー B-6 で確認)
    const tail = parts[run - 1] ?? '';
    if (!/\r?\n$/.test(tail)) parts[run - 1] = tail + eol;
    // 閉じを 1 行だけ補って、通常の経路へ合流する(以降は原文 splice のまま)
    parts.splice(run, 0, `---${eol}`);
    closeAt = run;
  }

  const fmParts = parts.slice(0, closeAt);
  for (const [key, value] of entries) {
    /**
     * ⚠ **字下げも見る**(2 巡目レビュー B-3)── 走は `line.slice(0, colon).trim()`
     *   なので字下げした key を frontmatter に入れるのに、書き換えは行頭固定だった。
     *   `---\n  status: open\n---` に `status` を書くと**同名 key が 2 本**になり、
     *   消すときは**無言の no-op** になっていた(片側だけ揃った状態)。
     */
    const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
    // 重複 key は**最後の一致**を書く ── parseFlatYaml は last-wins なので、
    // 先頭行を書くと再抽出が変わらず永久 no-op になる(P3-6a review #5)
    let at = -1;
    for (let i = 0; i < fmParts.length; i++) {
      if (keyRe.test(fmParts[i]!)) at = i;
    }
    const line = lineFor([key, value]);
    if (at >= 0) {
      if (line === null) {
        fmParts.splice(at, 1);
      } else {
        // 既存行の行末記号を保持して差し替え
        const term = fmParts[at]!.match(/\r?\n$/)?.[0] ?? eol;
        /**
         * ⚠ **字下げも保つ**(2 巡目レビュー B-3)── この関数の契約は
         *   「本文・他 key・空行・コメントは byte 単位で無傷」である。
         *   字下げを落とすと、user が揃えた見た目が黙って崩れる。
         */
        const indent = /^\s*/.exec(fmParts[at]!)?.[0] ?? '';
        fmParts[at] = indent + line + term;
      }
    } else if (line !== null) {
      fmParts.push(line + eol);
    }
  }
  const rest = parts.slice(closeAt).join(''); // 閉じ fence 行から後ろは原文 byte のまま
  return `${open}${fmParts.join('')}${rest}`;
}
