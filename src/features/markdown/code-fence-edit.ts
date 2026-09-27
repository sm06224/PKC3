/**
 * 🔴 **コード枠(```)の中身だけを差し替える**(#1044 段3)。
 *
 * ⚠ **段2(`append-target.ts` の `sectionRange` / `replaceSectionByHeading`)と
 *   同じ形の関数を、枠のために 1 本足す**(2 つ目の規則を作らない ── CLAUDE.md §7)。
 *   章は「見出しの字」で探し直すが、枠には見出しのような一意な字が無いので、
 *   代わりに「開きの行の字 + 中身」を身元として使う(§9 の決定)。
 *
 * ## 座標系
 *
 * `line` は**生の body**(frontmatter を含む、`body.split(/\r?\n/)` の添字)である。
 * 呼び手(`binder.ts` / `app-state.ts`)が `frontmatterLineCount` を足して渡す ──
 * `append-target.ts` の `sectionAt` / `headingRefAt` と同じ規律(2 つ目のずらし方を
 * 作らない)。
 *
 * ## 引用(`>`)の中の枠(#775 と同じ作法)
 *
 * 中身を見せる・比べるときは引用の前置きを `quote` 段だけ剥がし、書き戻すときは
 * **開きの行が持っていた前置きの字**を、新しい行**すべて**に均等に付け直す
 * (`table-convert.ts` の `quoteLead`(文字列)と同じ考え方 ── 行ごとに前置きを
 * 数え直さない)。
 *
 * 🔑 **pure module**。DOM も state も知らない。
 */
import { allFences, quoteLead, type FenceSpan } from './source-blocks';

/** 開いたときに控える身元(#1044 段3、§9)。 */
export interface CodeFenceIdentity {
  /** 開きの行(生の body の行番号)。 */
  readonly line: number;
  /** 開きの行の字(引用の前置きを剥がした後 ── 柵 + 言語見出し)。 */
  readonly openLine: string;
  /** 開いたときに控えた、中身(引用の前置きを剥がした後。開き・閉じの行は含まない)。 */
  readonly original: string;
  /** 引用の深さ(0 = 引用の外)。 */
  readonly quote: number;
}

/**
 * 🔴 **`line` 行目が開く、閉じたコード枠を開く**(#1044 段3)。
 *
 * ⚠ **`line` は開きの行そのもの**でなければならない(章と違い、枠の中の
 *   任意の行から「その枠」を特定する意味論は要らない ── ✎ は枠の器に 1 つだけ在る)。
 * ⚠ **閉じていない枠(末尾まで続く)は開かない** ── 末尾がどこまでかを user が
 *   知らないまま差し替えると、閉じの柵を書き足すことになり、意図がずれる。
 *
 * @returns 開けなければ `null`(そこが枠でない / 開きの行でない / 閉じていない /
 *   引用の前置きが揃っていない)。
 */
export function openCodeFenceAt(body: string, line: number): CodeFenceIdentity | null {
  if (!Number.isInteger(line) || line < 0) return null;
  const fences = allFences(body);
  const fence = fences.find((f) => f.start === line);
  if (fence === undefined || fence.open) return null;
  const lines = body.split(/\r?\n/);
  const openRaw = lines[fence.start];
  if (openRaw === undefined) return null;
  const openLead = quoteLead(openRaw, fence.quote);
  if (openLead === null) return null;
  const inner: string[] = [];
  for (let i = fence.start + 1; i <= fence.end - 1; i += 1) {
    const raw = lines[i];
    if (raw === undefined) return null;
    const lead = quoteLead(raw, fence.quote);
    if (lead === null) return null;
    inner.push(raw.slice(lead));
  }
  return {
    line: fence.start,
    openLine: openRaw.slice(openLead),
    original: inner.join('\n'),
    quote: fence.quote,
  };
}

/**
 * `id` と同じ身元(開きの行の字 + 中身 + 引用の深さ)を持つ、閉じた枠か。
 * ⚠ **量が違うと `null` を返す `quoteLead` を経由するので、引用の段が
 *   揃わない枠は自動的に不一致になる**(揃わないまま升の字を書き換える事故を防ぐ ──
 *   #775 と同じ向き)。
 */
function fenceMatchesIdentity(
  lines: readonly string[],
  fence: FenceSpan,
  id: CodeFenceIdentity,
): boolean {
  if (fence.open || fence.quote !== id.quote) return false;
  const openRaw = lines[fence.start];
  if (openRaw === undefined) return false;
  const openLead = quoteLead(openRaw, fence.quote);
  if (openLead === null || openRaw.slice(openLead) !== id.openLine) return false;
  const inner: string[] = [];
  for (let i = fence.start + 1; i <= fence.end - 1; i += 1) {
    const raw = lines[i];
    if (raw === undefined) return false;
    const lead = quoteLead(raw, fence.quote);
    if (lead === null) return false;
    inner.push(raw.slice(lead));
  }
  return inner.join('\n') === id.original;
}

export type LocateCodeFenceResult =
  | { readonly ok: true; readonly fence: FenceSpan }
  /**
   * `missing` = 身元に一致する枠が 0 個(別の場所で書き換えられた、または移って
   * 中身も変わった)。`ambiguous` = 2 個以上(どの枠か決まらない)。
   */
  | { readonly ok: false; readonly reason: 'missing' | 'ambiguous' };

/**
 * 🔴 **身元で枠を探し直す**(#1044 段3、§9)。⚠ {@link replaceCodeFenceContent} と
 * **同じ探し方**(2 本目の規則を作らない)── 差し替えずに「いまどこに在るか」だけ
 * 知りたい呼び手(binder の「別の枠を開き直す」)のために分けてある。
 *
 * 🔑 手順(§9 の再掲):①**開いたときの行**に、いまも同じ身元の枠が在るかを見る
 * (行がずれていなければ、これで決まる)②居なければ、**同じ身元**(開きの行の字 +
 * 中身 + 引用の深さ)の枠を本文全体から探す ── 1 個ならそれに決まる、0 個 /
 * 2 個以上は断る。
 */
export function locateCodeFence(body: string, id: CodeFenceIdentity): LocateCodeFenceResult {
  const lines = body.split(/\r?\n/);
  const fences = allFences(body);
  const direct = fences.find((f) => f.start === id.line);
  if (direct !== undefined && fenceMatchesIdentity(lines, direct, id)) {
    return { ok: true, fence: direct };
  }
  const matches = fences.filter((f) => fenceMatchesIdentity(lines, f, id));
  if (matches.length === 0) return { ok: false, reason: 'missing' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, fence: matches[0]! };
}

export type ReplaceCodeFenceResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly reason: 'missing' | 'ambiguous' };

/**
 * 🔴 **枠の中身を、身元で探し直して差し替える**(#1044 段3、§9)。
 *
 * @param body 差し替え先の本文(**disk から読み直した最新の本文**)
 * @param id 開いたときに控えた身元({@link openCodeFenceAt} の戻り値)
 * @param text 箱に打たれていた新しい中身(引用の前置きを含まない。開き・閉じの
 *   行は含まない)
 */
export function replaceCodeFenceContent(
  body: string,
  id: CodeFenceIdentity,
  text: string,
): ReplaceCodeFenceResult {
  const located = locateCodeFence(body, id);
  if (!located.ok) return located;
  const target = located.fence;
  const lines = body.split(/\r?\n/);
  /**
   * 🔑 **前置きは「開きの行が持っていた字」を、新しい行すべてへ均等に付け直す**
   * (`table-convert.ts` の `quoteLead` と同じ作法) ── 行ごとに前置きの綴りを
   * 組み直さない(user が書いた `>` / `> ` の綴りをそのまま返す)。
   */
  const openLead = quoteLead(lines[target.start]!, target.quote) ?? 0;
  const leadStr = lines[target.start]!.slice(0, openLead);
  const newInner = text.split(/\r?\n/).map((l) => leadStr + l);
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const newBody = [
    ...lines.slice(0, target.start + 1),
    ...newInner,
    ...lines.slice(target.end),
  ].join(eol);
  return { ok: true, body: newBody };
}
