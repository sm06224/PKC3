/**
 * 🔴 **書き出すとき、本文の `![説明](entry:ノート#h/見出し)`(別のノートの章を表示する)を、その章の中身で置き換える**
 * (#1459 段②「ノート部分参照の埋め込みで、帳票・レポート HTML を生成」)。
 *
 * > user の物語:バラバラのノートに書いた日々のメモ(章)を、1 枚の報告書のノートから `![](entry:…#h/…)` で
 * > 集めた。**書き出して人に渡す**と、画面ではその場に出ていた章が、空の枠(説明の字だけ)になっていた。
 *
 * 画面(`section-embed.ts`)は章を**その場に読み取り専用で描く**。書き出した HTML・Word・PowerPoint には
 * 描く側が居ないので、**書き出す側で原文を展開してから描く** ── 描くのは画面と同じ描画器なので、
 * 書き出したものが画面と別の見え方になることはない。
 *
 * ## 規則(画面の展開と同じ向き)
 *
 * - 展開するのは**行ぜんぶが 1 つの参照**の行だけ(行の途中の参照は触らない ── 画面も器を単独の塊として出す)。
 *   コードの囲みの中は触らない。
 * - 章の範囲は画面と同じ関数(`sectionRange`)。⚠ 画面の抜粋は長いと切る(`clipText`)が、**書き出しは切らない**
 *   (渡す物に「続きは元のノートで」は書けない)。章の中の `{{vars.x}}` は元のノートの前書きの値で出す(画面と同じ)。
 * - **深さ ≤ 1**:章の中にさらに参照があっても展開せず、題名のリンク(`[説明](entry:…)`)に降ろす。自分自身を指す参照も同じ
 *   (循環はここで止まる)。
 * - 章が見つからない / ノートが無いときは、**黙って空にせず**引用の 1 行(`> 「説明」: …`)を残す ── 渡した先でも理由が読める。
 *
 * ⚠ pure。ノートの本文を引く口(`bodyOf`)は呼び側が渡す(adapter の `ArchiveSource.getBody`)。
 */
import { parseEntryRef } from '../entry-ref/entry-ref';
import { sectionRange } from '../markdown/append-target';
import { fenceStep } from '../markdown/list-renumber';
import { expandDefinedVars } from '../markdown/var-expand';
import { extractVars } from '../markdown/frontmatter';
import type { ArchiveSource } from './pkc3-archive';

/** 行ぜんぶが `![説明](entry:…)` の行。⚠ ラベルは `\]` へ逃がされるので `[^\]]*` では途中で切れる。 */
const WHOLE_LINE_EMBED = /^(\s*)!\[((?:\\.|[^\]\\])*)\]\((entry:[^)\s]+)(?:\s+"[^"]*")?\)\s*$/u;

export const SECTION_FLATTEN_MISSING_SECTION = '見出しが見つかりません';
export const SECTION_FLATTEN_MISSING_NOTE = 'ノートが見つかりません';

export const SECTION_FLATTEN_SYSTEM_NOTE = '(システムのノートは書き出しに入れません)';

export interface FlattenRef {
  /** 重複排除の鍵(持ち込み先のノート × 参照先の章)。 */
  readonly key: string;
  readonly kind: 'expanded' | 'missing' | 'blocked';
  /** 章を持ち込んだ(参照先の)ノートの題名。分からなければ lid。 */
  readonly title: string;
}

export interface FlattenResult {
  readonly body: string;
  /** 展開できた章の数。 */
  readonly expanded: number;
  /** 見つからなかった参照の数(引用の 1 行を残した分)。 */
  readonly missing: number;
  /** system 領域のノートを指していたので展開しなかった数(引用の 1 行を残した分)。 */
  readonly blocked: number;
  /** 1 つずつの結果(呼び側が複数の呼びをまたいで重複を除くのに使う)。 */
  readonly refs: readonly FlattenRef[];
}

export interface FlattenOptions {
  /**
   * 🔴 **user 領域のノートの lid**(`listEntryMetas` は user 領域だけを返す)。渡すと、ここに無いのに本文が読めるノート
   *   = system 領域のノートの章は展開せず、引用の 1 行にする(メッセージ集積地などを渡す物に混ぜない)。
   *   渡さなければ(`null`)領域を見ない。
   */
  readonly userLids?: ReadonlySet<string> | null;
  /** 題名を引く口(知らせに出す)。 */
  readonly titleOf?: (lid: string) => string | undefined;
}

/** 展開しない参照を、押せる題名のリンクに降ろす。 */
function asLink(label: string, url: string): string {
  return `[${label}](${url})`;
}

/** 章の中の(行ぜんぶが参照の)参照を、題名のリンクへ降ろす。 */
function demoteNested(lines: readonly string[]): string[] {
  let fence = '';
  return lines.map((line) => {
    const st = fenceStep(fence, line);
    fence = st.next;
    if (st.inside) return line;
    const m = WHOLE_LINE_EMBED.exec(line);
    return m === null ? line : `${m[1]!}${asLink(m[2]!, m[3]!)}`;
  });
}

export async function flattenSectionEmbeds(
  body: string,
  selfLid: string,
  bodyOf: (lid: string) => Promise<string | null>,
  opts: FlattenOptions = {},
): Promise<FlattenResult> {
  if (!body.includes('](entry:')) return { body, expanded: 0, missing: 0, blocked: 0, refs: [] };
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r?\n/u);
  const out: string[] = [];
  const cache = new Map<string, string | null>();
  const refs: FlattenRef[] = [];
  let fence = '';
  for (const line of lines) {
    const st = fenceStep(fence, line);
    fence = st.next;
    const m = st.inside || !line.includes('![') ? null : WHOLE_LINE_EMBED.exec(line);
    if (m === null) {
      out.push(line);
      continue;
    }
    const ref = parseEntryRef(m[3]!);
    if (ref.kind !== 'section') {
      out.push(line);
      continue;
    }
    const label = m[2]!;
    if (ref.lid === selfLid) {
      out.push(`${m[1]!}${asLink(label, m[3]!)}`);
      continue;
    }
    const key = `${selfLid}\u0000${ref.lid}#${ref.id}`;
    const title = opts.titleOf?.(ref.lid) ?? ref.lid;
    // 🔴 system 領域のノートの章は、本文を読む前に断る(読めても渡す物に入れない)
    if (opts.userLids != null && !opts.userLids.has(ref.lid)) {
      // ⚠ 本当に無いノートと取り違えない ── 本文が読めるなら system 領域、読めなければ無い
      if (!cache.has(ref.lid)) cache.set(ref.lid, await bodyOf(ref.lid));
      if (cache.get(ref.lid) != null) {
        refs.push({ key, kind: 'blocked', title });
        out.push('', `> 「${label}」: ${SECTION_FLATTEN_SYSTEM_NOTE}`, '');
        continue;
      }
    }
    if (!cache.has(ref.lid)) cache.set(ref.lid, await bodyOf(ref.lid));
    const other = cache.get(ref.lid) ?? null;
    if (other === null) {
      refs.push({ key, kind: 'missing', title });
      out.push('', `> 「${label}」: ${SECTION_FLATTEN_MISSING_NOTE}`, '');
      continue;
    }
    const range = sectionRange(other, ref.id);
    if (range === null) {
      refs.push({ key, kind: 'missing', title });
      out.push('', `> 「${label}」: ${SECTION_FLATTEN_MISSING_SECTION}`, '');
      continue;
    }
    const sec = other.split(/\r?\n/u).slice(range.start, range.end);
    while (sec.length > 1 && sec[sec.length - 1]!.trim() === '') sec.pop();
    const text = expandDefinedVars(demoteNested(sec).join('\n'), extractVars(other));
    refs.push({ key, kind: 'expanded', title });
    out.push('', ...text.split('\n'), '');
  }
  const count = (k: FlattenRef['kind']): number => refs.filter((r) => r.kind === k).length;
  return { body: out.join(eol), expanded: count('expanded'), missing: count('missing'), blocked: count('blocked'), refs };
}

/** 展開した件数(書き出した後の知らせに使う)。⚠ 同じ(持ち込み先 × 章)は 1 回しか数えない。 */
export interface FlattenStats {
  expanded: number;
  missing: number;
  blocked: number;
  /** 章を持ち込んだ(参照先の)ノートの題名(重複なし・出てくる順)。 */
  titles: string[];
}

export const newFlattenStats = (): FlattenStats => ({ expanded: 0, missing: 0, blocked: 0, titles: [] });

/** 知らせの 1 句「(元のノート: A・B ほか N 件)」。無ければ空。 */
export function flattenTitlesNote(titles: readonly string[]): string {
  if (titles.length === 0) return '';
  const shown = titles.slice(0, 5).join('・');
  return `(元のノート: ${shown}${titles.length > 5 ? ` ほか ${String(titles.length - 5)} 件` : ''})`;
}

/**
 * 🔴 **本文を読むたびに、章の参照を展開する源**(書き出し用)。
 *
 * ⚠ **絞り込み(`singleEntrySource` など)の前**に包む ── 絞り込みは本文から添付の使用を数えるので、展開した後の本文を
 *   見せないと、**他のノートの章の中の画像**が添付として入らない。
 * ⚠ 本文を引く口(`getBody`)が無い源は包まない(引けない相手は展開できない)。
 * ⚠ **件数は(持ち込み先 × 章)の集合で数える** ── 絞り込みは本文を 1 周目と 2 周目で 2 回読むので、素直に足すと 2 重になる。
 * ⚠ 原文は書き換えない(読んだ値を返すときに展開するだけ)。バックアップ・Markdown の源には使わない。
 */
export function withFlattenedSectionEmbeds(source: ArchiveSource, stats: FlattenStats): ArchiveSource {
  const getBody = source.getBody?.bind(source);
  if (getBody === undefined) return source;
  const seen = new Set<string>();
  let meta: Promise<{ userLids: Set<string>; titles: Map<string, string> }> | null = null;
  const metas = (): Promise<{ userLids: Set<string>; titles: Map<string, string> }> => {
    meta ??= source.listEntryMetas().then((rows) => ({
      userLids: new Set(rows.map((r) => r.lid)),
      titles: new Map(rows.map((r) => [r.lid, r.title] as const)),
    }));
    return meta;
  };
  const flat = async (lid: string, body: string): Promise<string> => {
    if (!body.includes('](entry:')) return body;
    const m = await metas();
    const r = await flattenSectionEmbeds(body, lid, getBody, {
      userLids: m.userLids,
      titleOf: (l) => m.titles.get(l),
    });
    for (const ref of r.refs) {
      if (seen.has(ref.key)) continue;
      seen.add(ref.key);
      if (ref.kind === 'expanded') {
        stats.expanded += 1;
        if (!stats.titles.includes(ref.title)) stats.titles.push(ref.title);
      } else if (ref.kind === 'missing') stats.missing += 1;
      else stats.blocked += 1;
    }
    return r.body;
  };
  return Object.assign(Object.create(source) as ArchiveSource, {
    getBody: async (lid: string): Promise<string | null> => {
      const body = await getBody(lid);
      return body === null ? null : flat(lid, body);
    },
    listBodies: async (...args: Parameters<ArchiveSource['listBodies']>) => {
      const r = await source.listBodies(...args);
      const rows: Array<{ lid: string; body: string }> = [];
      for (const row of r.rows) rows.push({ ...row, body: await flat(row.lid, row.body) });
      return { ...r, rows };
    },
  });
}
