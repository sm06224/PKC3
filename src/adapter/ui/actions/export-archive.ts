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

export interface ExportDeps {
  source: ArchiveSource;
  /** 生成した Blob を user に渡す(実配線は `<a download>`)。 */
  download(name: string, blob: Blob): void;
  notify?(message: string): void;
  /** 注意の全件(1 行の status では 1 件目しか届かない ── P6c review H-2)。 */
  report?(notes: readonly string[]): void;
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
  return s.slice(0, 60) || 'pkc3';
}

const stamp = (d: Date): string =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * アーカイブを書き出してダウンロードさせる。
 * @returns 書き出した entry 数(失敗時は null)
 */
export async function exportArchive(
  dispatcher: Dispatcher,
  deps: ExportDeps,
): Promise<number | null> {
  const fail = (msg: string): null => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  // 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  if (dispatcher.getState().phase !== 'ready') {
    return fail('編集を終了してから書き出してください');
  }

  deps.notify?.('書き出しています…');
  try {
    const now = deps.now?.() ?? new Date();
    const out = await writeArchive(deps.source, now.toISOString());
    deps.download(`${safeName(deps.source.title)}-${stamp(now)}.pkc3.zip`, out.blob);

    deps.report?.(out.warnings);
    const c = out.counts;
    const detail = `${c.entries} 件(関連 ${c.relations} / 履歴 ${c.revisions} / 添付 ${c.assets})`;
    deps.notify?.(
      out.warnings.length > 0
        ? `書き出しました: ${detail} ⚠ 注意 ${out.warnings.length} 件`
        : `書き出しました: ${detail}`,
    );
    return c.entries;
  } catch (e) {
    return fail(`書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
  }
}
