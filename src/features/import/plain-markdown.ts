/**
 * P7 段②: **素の `.md` を 1 件受け取って entry にする**(設計 doc §1)。
 *
 * 🔑 **md ZIP(段④ の書出し)の逆ではない**。あちらは「フォルダごと」、
 * これは「1 ファイル」── 混ぜると「どっちの経路で壊れたか」が分からなくなる
 * (裁定 §5-4)。フォルダ取込(`assets/` の解決込み)は別の段。
 *
 * ⚠ **本文は原文のまま**。frontmatter を parse し直して再構築しない ── P6d 段④ で
 * 踏んだ規律(`parseFrontmatter` + `serializeFrontmatter` の往復は入れ子 mapping /
 * block scalar / コメントを落とし、16KB 級の frontmatter では body を消し飛ばした)。
 * ここで parse するのは **題名と archetype を読むためだけ**で、書き戻さない。
 */
import { parseFrontmatter } from '@features/markdown/frontmatter';
import { scanLinks } from '@features/markdown/link-scan';

/** `file_handlers` が宣言する拡張子。⚠ manifest と parity test で縛る。 */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const;

/** 題名の上限。1 行に 100 万字の「題名」を作らせない(本文は原文のまま残る)。 */
const TITLE_MAX = 200;

/**
 * frontmatter の `archetype` として受ける値。
 *
 * 🔴 **「フレーバーが登録されているか」で判定してはいけない**(review M-2)。
 * `getFlavor` は登録の無い archetype を text にフォールバックするので、その式は
 * `folder` / `generic` / `opaque` ── **一級の archetype なのに専用フレーバーを
 * 持たないもの** ── を「未知」として拒む。⚠ 自分の md ZIP export は全 entry に
 * `archetype: <値>` を書くので、**自分で書き出した md を取り込み直すと
 * フォルダがノートに化け、しかも事実に反する「未知」注意が出て**いた。
 *
 * ⚠ `attachment` は入れない ── 単一 md は bytes を持ってこられないので、
 * 受けると**中身の無い添付 entry**ができる(開けないのに壊れて見えない)。
 */
const ACCEPTED_ARCHETYPES: ReadonlySet<string> = new Set([
  'text',
  'todo',
  'textlog',
  'form',
  'spreadsheet',
  // 🔴 **雛形も受ける**(#196 / B-2、2026-08-25)。⚠ 受けないと、書き出した雛形を
  //    取り込み直したとき**普通のノートに化ける** ── 「取り込みが何も足さずに通る」は
  //    archetype に置いた理由そのものなので、ここを落とすとその理由が嘘になる。
  //    ⚠ 単一 md で完結する(bytes を持たない)ので `attachment` の理由は当たらない。
  'snippet',
  // 🔴 **スタックも受ける**(#633 段③)── 受けないと、書き出した入れ物を取り込み直したとき
  //    普通のノートに化ける(雛形と同じ理由。本文はリンクの箇条書きで単一 md に収まる)
  'stack',
  'folder',
  'generic',
  'opaque',
]);

export interface PlainMarkdownEntry {
  title: string;
  archetype: string;
  /** **原文のまま**(frontmatter を含む)。 */
  body: string;
  /** 解決しない相対パス参照(`![](images/a.png)` など)の重複除去済み一覧。 */
  unresolvedRefs: string[];
  /** 可視化する注意。空 = 何も言うことがない。 */
  warnings: string[];
}

/** 拡張子で md か判定する。⚠ 中身では判定しない ── **どんなテキストも md として妥当**。 */
export function isMarkdownFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** ファイル名 → 題名候補(ディレクトリと拡張子を落とす)。 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const lower = base.toLowerCase();
  const ext = MARKDOWN_EXTENSIONS.find((e) => lower.endsWith(e));
  return (ext ? base.slice(0, -ext.length) : base).trim();
}

/**
 * 本文の先頭 ATX 見出し(`# 見出し`)を拾う。
 *
 * ⚠ **fence の中は見出しではない**。``` で囲まれた `# comment` を題名にすると、
 * shell script を貼った md が全部「# !/bin/bash」になる。
 * ⚠ setext(`題名\n===`)は拾わない ── 拾う判定を増やすほど「どれで決まったか」が
 * 説明できなくなる。宣言した規則(doc §1)は ATX だけである。
 */
export function firstHeading(body: string): string | null {
  let fence: { char: string; len: number } | null = null;
  // 🔴 **`split('\n')` で全行を作らない**。見出しは普通いちばん上にあるのに、
  // 3MB の md では**全部を配列にしてから 1 行目を見て**いた(実測 214ms)。
  // 行境界を都度探して、見つけた時点で抜ける ── 同 0.01ms。
  // 🔴 **行末は `\n` だけではない**。CommonMark の line ending は `\n` / `\r` /
  // `\r\n` の 3 つで、markdown-it も `\r\n?` を `\n` に正規化してから parse する。
  // `split('\n')` は `\r` を行末に残し、`.` は `\r` にマッチせず `$` は文字列末尾
  // のみなので `# 見出し\r` は**どうやってもマッチしない** ── CRLF の md
  // (Windows / autocrlf)では題名の 2 段目が丸ごと死んでいた(review H-1)。
  // ⚠ frontmatter 付きの入力では `parseFrontmatter` が CRLF を正規化して
  // **救ってしまう**ので、pin するときは frontmatter 無しで見ること
  const EOL = /\r\n|[\r\n]/g;
  for (let start = 0; start <= body.length; ) {
    EOL.lastIndex = start;
    const eol = EOL.exec(body);
    const line = body.slice(start, eol ? eol.index : body.length);
    start = eol ? eol.index + eol[0].length : body.length + 1;
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMark) {
      const mark = fenceMark[1]!;
      // ⚠ **閉じは開き以上の長さ**(CommonMark)── 1 文字比較だと
      // 「4 個で開いて 3 個で閉じる」= markdown を説明する文書が壊れ、
      // コードブロックの中の見出しが題名になる(review M-1 で実証)
      if (fence === null) fence = { char: mark[0]!, len: mark.length };
      else if (mark[0] === fence.char && mark.length >= fence.len) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const atx = /^ {0,3}#{1,6}(?:\s+(.*))?$/.exec(line);
    if (atx) {
      // 閉じ `#` を落とす(`# 題名 ###`)。`#` だけの行は題名なしとして次を見ない
      const text = (atx[1] ?? '').replace(/\s+#+\s*$/, '').trim();
      return text === '' ? null : text;
    }
  }
  return null;
}

/**
 * 相対パス参照(解決しない)を数える。⚠ 数えるだけで、本文は書き換えない。
 *
 * 🔴 走査は **`markdown/link-scan.ts` の 1 本**に寄せてある(review M-3)。
 * 自前で `](…)` だけを見ていたときは、**参照形式リンクと HTML の `src`** ──
 * つまり「黙って画像が壊れる」いちばん数えたい形 ── を取りこぼし、逆に
 * fence / 行内コード / エスケープの中まで数えて**嘘の警告**を出していた
 * (誤差が両方向に出ていた)。
 */
function scanUnresolvedRefs(text: string): string[] {
  const found = new Set<string>();
  for (const site of scanLinks(text).sites) {
    const dest = site.dest.trim();
    if (dest === '') continue;
    // 外部 URL / 内部 anchor / 既に解決済みの添付参照は「未解決」ではない
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest) || dest.startsWith('#') || dest.startsWith('//')) {
      continue;
    }
    found.add(dest);
  }
  return [...found];
}

/**
 * 素の markdown 1 件を entry の材料にする。**純関数**(I/O も採番もしない)。
 *
 * @param text ファイルの中身(原文)
 * @param fileName 題名の最終候補。拡張子とディレクトリは落とす
 */
export function readPlainMarkdown(text: string, fileName: string): PlainMarkdownEntry {
  const warnings: string[] = [];
  const parsed = parseFrontmatter(text);
  // ⚠ cap 超過などで parse を諦めたときは `meta: {}` で返る ── **黙らせない**。
  // 題名や archetype が frontmatter にあるのに使われなかった、が静かに起きる
  for (const w of parsed.warnings) warnings.push(`frontmatter: ${w.detail}`);

  const metaTitle = parsed.meta['title'];
  const heading = firstHeading(parsed.body);
  const fromName = titleFromFileName(fileName);
  const rawTitle =
    (typeof metaTitle === 'string' && metaTitle.trim() !== '' ? metaTitle.trim() : null) ??
    heading ??
    (fromName !== '' ? fromName : null) ??
    '無題';
  const title =
    rawTitle.length > TITLE_MAX ? `${rawTitle.slice(0, TITLE_MAX - 1)}…` : rawTitle;

  // archetype は**登録済みのものだけ**受ける。未知の値をそのまま入れると
  // 「flavor が text fallback で動くのに、entry には嘘の archetype が残る」
  const metaArchetype = parsed.meta['archetype'];
  let archetype = 'text';
  if (typeof metaArchetype === 'string' && metaArchetype !== '') {
    if (ACCEPTED_ARCHETYPES.has(metaArchetype)) archetype = metaArchetype;
    else warnings.push(`archetype "${metaArchetype}" は受けられないので text にしました`);
  }

  // ⚠ 走査は **原文**に対して行う ── frontmatter の値に書かれた `![](x.png)` は
  // 本文の参照ではないが、`parsed.body` は cap 超過時に原文まるごとになる
  // (諦めると `body === text`)ので、どちらを渡しても frontmatter を完全には
  // 除けない。原文に統一して「多めに数える」側へ倒す ── 誤差の向きは
  // **false-keep**(言い過ぎ)側であって、黙って落とす側ではない
  const unresolvedRefs = scanUnresolvedRefs(text);
  if (unresolvedRefs.length > 0) {
    // 🔑 **件数で言う**(doc §1)。単一 md は添付を持ってこないので、参照は原文の
    // まま残る ── 黙って残すと「画像が出ない」だけが user に見える
    warnings.push(
      `画像・ファイルへの参照 ${unresolvedRefs.length} 件は解決していません(単一 md は添付を含みません): ${unresolvedRefs.slice(0, 5).join(', ')}${unresolvedRefs.length > 5 ? ' …' : ''}`,
    );
  }

  // ⚠ body は **text そのもの**。`parsed.body` ではない(あれは frontmatter を
  // 落としたうえ CRLF まで正規化されている ── 原文のままにならない)
  return { title, archetype, body: text, unresolvedRefs, warnings };
}
