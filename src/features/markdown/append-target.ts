/**
 * 🔴 **追記の「入る先」を選べるようにする**(#395 段①)。
 *
 * > user の物語: 長い議事録の「決定事項」の節に **1 行だけ**足したい。
 * > いまは「編集」を押して本文を開き、目で節を探すしかない ──
 * > その間、**組んだ本文は消えている**(読みながら書けない)。
 *
 * CLAUDE.md が PKC2 の核の 3 番目として名指ししている「**開かずに済ませる道**」の
 * 実体である(「編集の大半は追記と差し挟み(Vim 的発想)」)。
 *
 * ## 🔴 行番号ではなく**見出しの印**で指す
 *
 * ⚠ 追記は `getBody` → 足す → 書込 の順に進み、**その間に別の窓が書いていれば
 *   読み直して足し直す**(`store-effects.ts` の `tryAppend`)。
 *   そこで**行番号を握っていると、足し直しで別の場所へ入る** ── しかも
 *   user から見て「変な所に入った」だけで、なぜかは分からない。
 * 🔑 だから指すのは**印(slug)**で、**そのつど本文から解く**。
 * 🔴 **解けなければ足さない**(末尾へ落とさない)── 「選んだ先が消えているのに、
 *   黙って別の場所へ入る」が、この機構でいちばんやってはいけない負け方である。
 *
 * ## ⚠ 印の作り方は**目次と同じ**(2 つ目の命名規則を作らない)
 *
 * `makeSlugCounter()` を使う ── 目次・本文のアンカーと同じ綴りになるので、
 * 「目次で見えている節の名前」と「追記で選ぶ名前」が食い違わない。
 *
 * 🔑 **pure module**。DOM も窓も知らない。
 */
import { makeSlugCounter } from './markdown-toc';
import { parseFrontmatter } from './frontmatter';

/** 追記の入り先 1 つ。 */
export interface AppendTarget {
  /** 印。⚠ **目次と同じ綴り**(`makeSlugCounter`)。 */
  readonly slug: string;
  /** 見出しの字(画面に出す)。 */
  readonly text: string;
  /** 1〜3。字下げの深さに使う。 */
  readonly level: 1 | 2 | 3;
}

/** 見出し 1 つの居場所(内部用 ── 行番号は**その場で**しか使わない)。 */
interface HeadingAt extends AppendTarget {
  /** 見出しそのものの行(0 起点、**原文の**行番号)。 */
  readonly line: number;
}

/**
 * 原文から見出しを拾う。⚠ **原文の行番号**を持つ(frontmatter を剥がさない)。
 *
 * ⚠ `extractHeadingsFromMarkdown` は使えない ── あちらは frontmatter を剥がし
 *   `{{vars}}` を展開してから拾うので、**行番号が原文とずれる**(目次には要らないが、
 *   ここでは行を切るので致命的である)。🔑 代わりに**印の作り方だけ**を借りる。
 * ⚠ fence の中は見ない(コードの中の `# x` は見出しではない)。
 * ⚠ frontmatter の中も見ない(`title: # x` を見出しに数えない)。
 */
function scanHeadings(body: string): HeadingAt[] {
  const lines = body.split(/\r?\n/);
  // 🔑 frontmatter の**行数**だけ借りて、その先から見る(剥がした本文は使わない)
  const fm = parseFrontmatter(body);
  const skip = fm.found ? lines.length - fm.body.split(/\r?\n/).length : 0;
  const slugOf = makeSlugCounter();
  const out: HeadingAt[] = [];
  let inFence = false;
  for (let i = skip; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^ {0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2]!.trim();
    if (text === '') continue;
    out.push({ slug: slugOf(text), text, level: m[1]!.length as 1 | 2 | 3, line: i });
  }
  return out;
}

/**
 * 選べる入り先を並べる(**末尾は含まない** ── 画面側が既定として先に置く)。
 *
 * ⚠ 同じ字の見出しが 2 つあっても**別の印**になる(`makeSlugCounter` が
 *   `決定事項` / `決定事項-1` と振る)── 潰すと user が選んだほうと違う所へ入る。
 */
export function listAppendTargets(body: string): readonly AppendTarget[] {
  return scanHeadings(body).map(({ slug, text, level }) => ({ slug, text, level }));
}

/**
 * その節の**終わり**(= 次の同格以上の見出しの直前)の行を返す。
 *
 * @returns 挿す位置の行(0 起点、**その行の前**に入る)。印が無ければ `null`
 *
 * ⚠ 末尾の空行は**跨がない** ── 節の末尾に空行が 2 つあるとき、その後ろに入れると
 *   見た目が節の外になる。🔑 **実のある最後の行の次**に入れる。
 */
export function resolveAppendAt(body: string, slug: string): number | null {
  const heads = scanHeadings(body);
  const at = heads.findIndex((h) => h.slug === slug);
  if (at < 0) return null;
  const me = heads[at]!;
  const lines = body.split(/\r?\n/);
  // 次の**同格以上**の見出し(深い見出しは自分の節の中身なので跨ぐ)
  let end = lines.length;
  for (let i = at + 1; i < heads.length; i++) {
    if (heads[i]!.level <= me.level) {
      end = heads[i]!.line;
      break;
    }
  }
  // 実のある最後の行まで巻き戻す(空行の下に置かない)
  let last = end - 1;
  while (last > me.line && lines[last]!.trim() === '') last--;
  return last + 1;
}

/**
 * 選んだ節の末尾へ一塊を差し挟む。
 *
 * @returns 新しい本文。⚠ **印が解けない / 中身が空**なら `null`
 *   ── 呼び側は**理由を出して止める**(末尾へ落とさない)。
 *
 * ⚠ `appendBlock`(末尾)と**別の関数**にしてある ── 末尾は「後ろに足す」、
 *   こちらは「間に挟む」で、前後の空行の作法が違う。1 つにまとめると
 *   どちらかが不自然になる。
 */
export function appendIntoSection(
  base: string,
  slug: string,
  heading: string | null,
  text: string,
): string | null {
  const body = text.replace(/\s+$/, '');
  if (body === '') return null;
  const at = resolveAppendAt(base, slug);
  if (at === null) return null;
  const lines = base.split('\n');
  const block = heading === null ? [body] : [heading, '', body];
  /**
   * ⚠ **前に 1 行空ける**(直前が空行でなければ)。空けないと、直前の段落と
   *   繋がって**1 つの段落として描かれる**(user から見て「くっついた」)。
   * ⚠ **後ろにも 1 行空ける**(次が在って空行でなければ)── 次の見出しと
   *   くっつかないように。
   */
  const before = at > 0 && lines[at - 1]!.trim() !== '' ? [''] : [];
  const after = at < lines.length && lines[at]!.trim() !== '' ? [''] : [];
  return [...lines.slice(0, at), ...before, ...block, ...after, ...lines.slice(at)].join('\n');
}

/**
 * 🔴 **足した行そのものを取り出す**(#395 段①、取り消しのため)。
 *
 * > user 指示 2026-08-23「**片道の操作を作らない**」
 *
 * ⚠ **結果から導く**(挿し込みの規則を書き写さない)── 前後の空行を足す作法を
 *   ここで再現すると、規則が 2 か所になり片方だけ古くなる(§7)。
 *   🔑 `base` と `next` の**共通の前後**を削れば、残るのが挿し込んだ run である。
 *
 * @returns 挿し込まれた行の並び。⚠ **純粋な挿入でなければ `null`**
 *   (置換・削除が混ざっていたら、取り消しの材料にしてはいけない)
 */
export function insertedLines(base: string, next: string): readonly string[] | null {
  const a = base.split('\n');
  const b = next.split('\n');
  if (b.length <= a.length) return null;
  let head = 0;
  while (head < a.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  // ⚠ 前後を削って **`a` 側が空になる**ときだけ「純粋な挿入」である
  if (head + tail !== a.length) return null;
  const run = b.slice(head, b.length - tail);
  return run.length > 0 ? run : null;
}

/**
 * 🔴 **足した行を取り消す**(#395 段①)。
 *
 * ⚠ **行番号で消さない** ── 追記のあとに別の窓が上へ足していれば番号はずれる。
 *   🔑 **その行の並びが在る所**を探して消す(無ければ消さない)。
 * ⚠ **いちばん後ろの一致**を消す ── 同じ字を 2 回足したとき、消えるのは
 *   **さっき足したほう**であってほしい(user が押した「元に戻す」は直前の 1 手である)。
 *
 * @returns 消したあとの本文。⚠ **見つからなければ `null`**(黙って別の所を消さない)
 */
export function removeInsertedLines(body: string, run: readonly string[]): string | null {
  if (run.length === 0) return null;
  const lines = body.split('\n');
  for (let at = lines.length - run.length; at >= 0; at--) {
    let hit = true;
    for (let i = 0; i < run.length; i++) {
      if (lines[at + i] !== run[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return [...lines.slice(0, at), ...lines.slice(at + run.length)].join('\n');
  }
  return null;
}

/**
 * 🔴 **その行が居る節を引く**(#495。Alt+クリックで追記の入り先を指す)。
 *
 * > user 裁定 2026-08-27「**センターペインの追記位置指定は Alt+クリックにしましょう**」
 *
 * 押した所から**いちばん近い上の見出し**を返す ── 深い見出しの中で押したら
 * その深い見出しが返る(`resolveAppendAt` が「次の同格以上の見出しの直前」まで
 * を節と数えるので、**選んだ節の末尾**は押した所を含む節の末尾になる)。
 *
 * @param line **原文の**行番号(0 起点)。⚠ 描く面は frontmatter を剥がした側を
 *   見ているので、呼び側が `frontmatterLineCount` を足してから渡す ──
 *   ずらす値は 1 か所(`detail.ts` の `fmLines` と同じ規律)。
 * @returns その節の見出し。⚠ **上に見出しが 1 つも無ければ `null`**
 *   ── 呼び側は**入り先を変えない**(「末尾」へ落とすと、上のほうを押したのに
 *   文書のいちばん下へ入る = いちばん静かな取り違えになる)。
 */
export function sectionAt(body: string, line: number): AppendTarget | null {
  let hit: HeadingAt | null = null;
  for (const h of scanHeadings(body)) {
    if (h.line > line) break;
    hit = h;
  }
  if (hit === null) return null;
  return { slug: hit.slug, text: hit.text, level: hit.level };
}
