/**
 * P6d 段②: アーカイブ ZIP の書出し(実行部)。
 *
 * 🔴 **writer だけ増やしても user は 1 件も書き出せない**(P6b で確立した規律 ──
 * 受理器だけ増やして「読めたつもり」の検証もできなかった失敗の裏返し)。
 * ここで store → 書出し → ダウンロードまでを 1 本に通す。
 *
 * ⚠ 書出しは **asset gate の内側**(取込 / 整理と排他)。書出し中に添付が
 * 掃除されると「meta はあるが bytes が無い」を掴んで欠けたアーカイブができる。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { writeArchive, type ArchiveSource } from '@features/export/pkc3-archive';
import { writePortableHtml } from '@features/export/pkc3-html';

export interface ExportDeps {
  source: ArchiveSource;
  /** 生成した Blob を user に渡す(実配線は `<a download>`)。 */
  download(name: string, blob: Blob): void;
  notify?(message: string): void;
  /**
   * 注意の全件(1 行の status では 1 件目しか届かない ── P6c review H-2)。
   *
   * ⚠ **optional にしない**(review M1)。リファクタでこの配線が落ちたとき、
   * optional だと typecheck も lint も test も鳴らず、user が見るのは
   * 「⚠ 注意 1 件」だけ ── **どの添付が欠けたか**が消える。必須にしておけば
   * 配線を落とした瞬間に tsc が止める。要らない呼び出し側は `() => {}` を書く
   * (書かされること自体が「注意を捨てている」の明示になる)
   */
  report(notes: readonly string[]): void;
  now?(): Date;
}

/** ファイル名に使えない文字を落とす(OS 差を避けて保守的に)。 */
function safeName(title: string): string {
  // ⚠ 制御文字は**正規表現に書かない**(no-control-regex。文字クラスに直接
  // 埋めると読み手が範囲を誤りやすく、実際ファイル中に生バイトが入っていた)
  const cleaned = [...title]
    .map((ch) => (ch.codePointAt(0)! < 0x20 || ch === '\u007f' ? '-' : ch))
    .join('');
  const s = cleaned.replace(/[\\/:*?"<>| ]+/g, '-').replace(/^[-.\s]+|[-.\s]+$/g, '');
  // ⚠ 空にしない ── 「.pkc3.zip」だけのファイル名は OS によっては隠しファイル
  // ⚠ `slice` は**サロゲートペアを割る**(絵文字や一部の漢字が壊れる)──
  // 制御文字処理でわざわざ [...] を使ったのに、最後で落とすと意味がない
  return [...s].slice(0, 60).join('') || 'pkc3';
}

const stamp = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** 書き出す形式。⚠ **可逆なのはアーカイブだけ**(UI でそう言う)。 */
export type ExportKind = 'archive' | 'html';

/**
 * 書き出してダウンロードさせる。
 * @returns 書き出した entry 数(失敗時は null)
 */
export async function exportArchive(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  kind: ExportKind = 'archive',
): Promise<number | null> {
  const fail = (msg: string): null => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  // 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  if (dispatcher.getState().phase !== 'ready') {
    return fail('編集を終了してから書き出してください');
  }

  deps.notify?.(kind === 'html' ? '閲覧用 HTML を書き出しています…' : '書き出しています…');
  try {
    const now = deps.now?.() ?? new Date();
    const base = `${safeName(deps.source.title)}-${stamp(now)}`;
    const iso = now.toISOString();

    let out: {
      blob: Blob;
      warnings: string[];
      counts: { entries: number; assets: number; relations?: number; revisions?: number };
    };
    let name: string;
    let detail: string;
    if (kind === 'html') {
      out = await writePortableHtml(deps.source, iso);
      name = `${base}.html`;
      // ⚠ **可逆ではない**ことをその場で言う(後から見分けられない形にしない ──
      // PKC2 は light / full の別を manifest にしか書いておらず user が困っていた)
      detail = `${out.counts.entries} 件(添付 ${out.counts.assets})── 閲覧用(取り込み直せません)`;
    } else {
      out = await writeArchive(deps.source, iso);
      name = `${base}.pkc3.zip`;
      const c = out.counts;
      detail = `${c.entries} 件(関連 ${c.relations} / 履歴 ${c.revisions} / 添付 ${c.assets})`;
    }
    deps.download(name, out.blob);
    deps.report(out.warnings);
    deps.notify?.(
      out.warnings.length > 0
        ? `書き出しました: ${detail} ⚠ 注意 ${out.warnings.length} 件`
        : `書き出しました: ${detail}`,
    );
    return out.counts.entries;
  } catch (e) {
    return fail(`書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}
