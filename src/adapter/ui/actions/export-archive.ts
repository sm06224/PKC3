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
import { errorText } from '@features/error-text';
import type { Dispatcher } from '@adapter/state/dispatcher';
import { exportBlockedNote } from '@adapter/state/app-state';
import { writeArchive, type ArchiveSource } from '@features/export/pkc3-archive';
import { archiveFileName, type ArchiveKind } from '@features/export/archive-kind';
import { CORRUPT_REFUSAL, looksCorrupt } from '@features/storage/db-corruption';
import {
  rescueArchiveDetail,
  rescueArchiveSource,
  noteRescueWritten,
  type RescueAssets,
  type RescuePick,
  type RescueRelationsPick,
  type RescueRevisionsPick,
} from '@features/storage/rescue-archive';
import {
  collectFenceAssetKeys,
  type RenderMarkdownOptions,
} from '@features/markdown/markdown-render';
import { readFenceAssets } from '@features/asset/fence-asset-read';
import { embedSourceNotice, mathSourceNotice, writePortableHtml } from '@features/export/pkc3-html';
import { buildOoxmlFile } from '@adapter/platform/export/ooxml-client';
import type { OoxmlMedia } from '@adapter/platform/export/ooxml-assemble';
import type { DocxBlock } from '@features/export/docx';
import { svgToEmf } from '@features/export/svg-emf';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { bakeSqlEmbeds, type SqlEmbedAnswer } from '@features/markdown/sql-embed';
import { DEFAULT_PAGE_FORMAT, type PageFormat } from '@features/page-format';
import { DEFAULT_PROSE_ALIGN, type ProseAlign } from '@features/prose-align';
import { writeMarkdownZip, writeMarkdownTo } from '@features/export/pkc3-markdown-zip';
import { countNoteLinks, noteLinkNotice } from '@features/export/note-link-notice';
import { undefinedVarNotice } from '@features/export/undefined-var-notice';
import { insertPlacedNoteTitles } from '@features/export/placed-note-title';
import {
  createFreshSubfolder,
  folderSink,
  FolderWriteError,
  isPickerCancel,
  type FolderSink,
  type FolderWritePicker,
  type WritableDirLike,
} from '@adapter/platform/md-folder-export';
import { singleEntrySource } from '@features/export/single-entry-source';
import { folderSource } from '@features/export/folder-source';
import { parseFrontmatter, extractVars } from '@features/markdown/frontmatter';
import { extractHeadingNumberConfig } from '@features/markdown/document-globals';
import { safeName } from '@features/export/file-name';
import { createProgressThrottle } from './progress-throttle';
import type { JobControl } from './job-control';
import { isOperationCancelled, type CancelToken } from '@features/job-cancel';
import { dayStamp } from '@features/datetime/date-math';
import { assetRefsIn } from '@features/asset/asset-ref-scan';

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
  /**
   * 🔴 **飛んでいる書込を着地させてから読む**(2026-08-17 に実測で判明)。
   *
   * 書込は effect 層の 1 本の chain に直列化されるが、**書き出しの読みはその外**に
   * ある ── `getBody` は並んでいる書込を**追い越す**。実測(実ブラウザ、保存の
   * 直後に Word を押す)では **11/12 が保存前の本文**を書き出した。
   * 実体は `connectStoreEffects` が返す `settled()`。
   *
   * ⚠ **optional にしない**(`report` と同じ理由 ── review M1)。配線が落ちても
   * typecheck が黙ると、user から見える症状は「保存したのに古い本文が出る」
   * という**いちばん気づけない形**で戻ってくる。待つものが無い呼び側は
   * `async () => {}` を書く(書かされること自体が「待たない」の明示になる)。
   */
  settle(): Promise<void>;
  /**
   * 🔴 **保存領域に問題があるとき、自動で読める分だけ集める**(#1017 段④b)。
   *
   * ⚠ **省略可**(コレクション全体の「バックアップ」/「Markdown」以外の呼び出し
   *   ── 1 ノート・フォルダの書出しからは渡さない。壊れた DB では対象を絞る
   *   読み方(`singleEntrySource` / `folderSource`)自体が同じ理由で落ちるので、
   *   拾い出しの対象にならない)。
   * 🔑 渡っているときだけ、`writeArchive` / `writeMarkdownZip` が corrupt の綴りで
   *   落ちたら `rescueArchiveSource` へ切り替え、`.pkc3-part.zip` を落とす。
   */
  rescue?: {
    readonly pick: RescuePick;
    /** 🔑 つながり・履歴を読む口(#1087)。⚠ 必須 ── 渡し忘れると、静かに入らなくなる。 */
    readonly pickRelations: RescueRelationsPick;
    readonly pickRevisions: RescueRevisionsPick;
    readonly assets?: RescueAssets;
  };
  /**
   * 🔴 **図・グラフを 1 枚の PNG に焼く**(#187 段②)。焼けなければ `null`。
   *
   * ⚠ **optional にしない** ── 渡し忘れると、図の器の中の**原文が等幅の文字**として
   * 出る(PKC2 の失敗そのもの)。tsc に止めさせる。
   * 🔑 実体は画面と**同じ産出器**(`MERMAID_KIND` / `CHART_KIND` の `render`)──
   * ここで別に描くと、この機能の失敗の根である「レンダラが 2 本」に戻る。
   * @returns `cssWidth` は**画面に置くときの幅**(CSS px)。PNG の画素は dpr 倍ある。
   */
  renderFigure(
    kind: string,
    source: string,
    /**
     * 🔴 **紙の配色で焼くか**(#1163 依頼 233。Gemini の裁定:Word・PowerPoint に書き出すときは、配色によらず明るい配色で図を描く)。
     * ⚠ 省略 = 画面と同じ配色(閲覧用 HTML は今までどおり)。Word・PowerPoint は白いページに載るので、ダークのままだと
     *   明るい線と字の図が白地に載って読みにくい。
     */
    paper?: boolean,
  ): Promise<{ blob: Blob; cssWidth: number } | null>;
  /**
   * 🔴 **図をベクタ(SVG)で起こす**(#238。user 指示 2026-08-17
   * 「**フローチャートのようないじれそうなものは emf とか wmf にして欲しい**」)。
   *
   * ⚠ **optional にしない** ── 配線を落としても tsc が黙ると、戻ってくる症状は
   * 「図だけ画像に戻っている」という**気づけない形**になる。
   * ⚠ グラフ(chart.js)は **canvas に描くのでベクタ源が無い** ── `null` を返す。
   */
  renderFigureVector(
    kind: string,
    source: string,
    /** 🔴 紙の配色で起こすか(`renderFigure` と同じ ── #1163 依頼 233)。 */
    paper?: boolean,
  ): Promise<string | null>;
  now?(): Date;
  /**
   * 🔴 **途中でやめる**(台帳 #1852 束 F2 / 依頼 253 ── 大きいバックアップの書き出し)。⚠ **省略可** ── 無い配線は「やめる」ボタンを出さない。
   * 添付 1 件・ノート 1 かたまりを読むごとに印を見て、立っていればファイルを作らずに抜ける(ダウンロードも始めない)。
   */
  job?: JobControl;
  /**
   * 本文 1 件を HTML にする(閲覧用 HTML だけが使う。P8 段⑲)。
   *
   * ⚠ **省略できるようにしてある**が、アプリからは必ず**markdown ワーカー**を
   * 渡す ── 省略するとその場で描くので、件数ぶんメインスレッドが止まる
   * (user 指示 2026-08-03「基本的に重い処理はワーカーにしてください」)。
   */
  renderBody?(text: string, opts?: RenderMarkdownOptions): Promise<string>;
  /**
   * 🔴 **本文に埋め込んだ SQL(` ```sql embed `)の答えを引く**(#1223 Q3 = B)。
   * 書き出した**その時点の答え**を表にして焼く(原文の SQL も残る)。
   *
   * ⚠ **optional にしない** ── 配線を落としても tsc が黙ると、戻ってくる症状は
   *   「書き出した HTML / Word だけ、答えの表が無い」という**いちばん気づけない形**になる
   *   (画面では出ているので、書き出した後に初めて分かる)。
   * 🔑 実体は画面の埋め込みと**同じ入口**(`askSqlEmbed` ── 字の門・上限・直列)。
   * ⚠ 引けないときは**投げてよい** ── 焼く側が 1 行の注記にする(書き出しは止めない)。
   */
  askSql(sql: string): Promise<SqlEmbedAnswer>;
  /**
   * 書き出す HTML に外部画像を焼くか(2026-08-06、user 裁定)。
   * ⚠ **設定が「常にオン」のときだけ true** ── 判断は `main.ts` が持つ。
   *   ノートごとの同意は持ち込まない(書き出した HTML は別の人が開く)。
   */
  allowExternalImages?: boolean;
  /**
   * 紙面フォーマット(2026-08-08、user 裁定)。**書き出した瞬間の設定**を焼く。
   * ⚠ 省略すると既定(A4 縦)── いままでと同じ見え方に倒れる。
   * ⚠ 判断は `main.ts` が持つ(いま画面に当たっている値をそのまま渡す)。
   */
  pageFormat?: PageFormat;
  /**
   * 🔴 **本文の置き場所**(#722、2026-09-08)。**書き出した瞬間の設定**を焼く。
   * ⚠ 省略すると既定(中央)── いままでと同じ見え方に倒れる。
   * ⚠ 焼かないと、左寄せで読んでいる人が**書き出した HTML だけ中央**になる。
   */
  proseAlign?: ProseAlign;
}

// 🔑 file 名の「今日」は `dayStamp`(端末の暦日)1 本 ── ここに私的な stamp を持たない(#709)
const stamp = (d: Date): string => dayStamp(d, '');

/** 書き出す形式。⚠ **可逆なのはアーカイブだけ**(UI でそう言う)。 */
export type ExportKind = 'archive' | 'html' | 'markdown';

/**
 * 書き出しを始めたときに画面下へ出す字。⚠ **進行中の字なので `…` で終わる**(`status-notice.ts` の
 * `isProgressNotice` が見分ける ── 外れると結果として積まれる)。🔑 test が**この定数そのもの**を
 * 読んで見る(手で写した一覧は、ここを直しても動かない ── 着地後レビュー)。
 */
export const EXPORT_STARTING: Record<ExportKind, string> = {
  archive: '書き出しています…',
  html: '閲覧用 HTML を書き出しています…',
  markdown: 'Markdown を書き出しています…',
};

/**
 * 🔴 **アーカイブの出発点の広さ**(#1017 段④b)。⚠ `'part'`(読めた分だけ)は
 * **自動フォールバック専用**で、呼び出し元からは選べない(下の `exportArchive` の
 * 中でしか作らない) ── 押した人が意図して選ぶ物ではなく、保存領域に問題が
 * あったときに製品が代わりに選ぶ形だからである。
 */
type ArchiveScope = Extract<ArchiveKind, 'full' | 'notes'>;

/**
 * このノートだけをアーカイブとして書き出す(P6f)。
 *
 * user 指示 2026-08-02:「そういうのは削除じゃなくて**アーカイブエクスポートの
 * 導線**を用意すればいいのでは?」── 消す前に手元へ出せる場所を作る。
 * 形式はバックアップと**同じ形式**(`.pkc3-notes.zip`)なので、そのまま取り込み直せる。
 */
export async function exportEntry(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  lid: string,
  /**
   * 🔴 **どの形で出すか**(#491)。⚠ **既定値を持たせない** ── 渡し忘れても
   *   tsc が黙る形にすると、「閲覧用 HTML を押したのに `.pkc3.zip` が落ちる」
   *   という、**押した人にしか見えない**取り違えになる
   *   (CLAUDE.md「待ちの口は optional にしない」と同じ向き)。
   * 🔑 絞り込み(`singleEntrySource`)も断る条件も `settle()` の位置も**同じ道**を
   *   通る ── 別経路にすると「1 件の HTML だけ壊れている」が起きる(P6f の理由)。
   */
  kind: ExportKind,
): Promise<number | null> {
  // ⚠ **読みの前**に断る(review M-2)。`singleEntrySource` は store を舐めるので、
  // ガードが後ろにあると「30MB 読んでから編集中ですと言う」になる。
  // さらに、読みの途中で編集が確定すると body と鎖の基準 tip が別時刻になり、
  // 「読み → 編集 → 保存(ready へ戻る)→ ガード通過」で内部矛盾したアーカイブができる
  const blocked = exportBlockedNote(dispatcher.getState(), '書き出してください');
  if (blocked !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: blocked });
    return null;
  }
  try {
    // 🔴 直前の保存が disk に着いてから読む(読みは書込の chain の外に居る)
    await deps.settle();
    const { source, warnings } = await singleEntrySource(deps.source, lid);
    // 🔴 **`archiveScope: 'notes'`**(#1017 段④b)── 1 件だけの書出しは
    //   自動フォールバックの対象にしない(壊れた DB では絞り込みの読み自体が
    //   同じ理由で落ちるので、拾い出しの対象にならない)
    const n = await exportArchive(dispatcher, { ...deps, source }, kind, warnings, 'notes');
    return n;
  } catch (e) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `書き出しに失敗しました: ${errorText(e)}`,
    });
    return null;
  }
}

/**
 * 🔴 **このフォルダとその配下だけ**をアーカイブとして書き出す(#399 ①)。
 *
 * > user の物語: 「案件A」フォルダの中身だけを相手に渡したい。
 *
 * ⚠ **`exportEntry` と同じ骨組み**にしてある ── 断る条件も、`settle()` の位置も、
 *   最後に呼ぶ `exportArchive` も同じ。隣り合う 2 つの操作が別の作法で書かれていると、
 *   片方だけ直る形になる(§7)。
 * 🔑 違うのは絞り込みの関数だけ(`singleEntrySource` / `folderSource`)。
 */
export async function exportFolder(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  lid: string,
): Promise<number | null> {
  // ⚠ **読みの前**に断る(`exportEntry` と同じ理由 ── 30MB 読んでから断らない)
  const blocked = exportBlockedNote(dispatcher.getState(), '書き出してください');
  if (blocked !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: blocked });
    return null;
  }
  try {
    // 🔴 直前の保存が disk に着いてから読む(読みは書込の chain の外に居る)
    await deps.settle();
    const { source, warnings } = await folderSource(deps.source, lid);
    // 🔴 `archiveScope: 'notes'`(#1017 段④b。`exportEntry` と同じ理由)
    return await exportArchive(dispatcher, { ...deps, source }, 'archive', warnings, 'notes');
  } catch (e) {
    dispatcher.dispatch({
      type: 'OP_FAILED',
      error: `書き出しに失敗しました: ${errorText(e)}`,
    });
    return null;
  }
}

/** `exportArchive` が組み立てる出力の形(正常時・自動フォールバック時とも同じ)。 */
interface ArchiveWriteOut {
  readonly blob: Blob;
  readonly warnings: string[];
  readonly counts: { entries: number; assets: number; relations?: number; revisions?: number };
}

/**
 * 🔴 **保存領域に問題があるとき、自動で「読める分だけ」へ倒れる**(#1017 段④b)。
 *
 * ## なぜ「バックアップ」と「Markdown」の 2 つが対象か
 *
 * どちらも `deps.source.listEntryMetas()` / `listRelations()` などで**全 entry を
 * 読む**ので、壊れた DB では `rescue-archive.ts` の実測表(§「関係・履歴は索引を
 * 使う形でしか引けない」)と**同じ理由で rc 11 系の綴りで落ちる**。
 *
 * ## 🔑 「大きすぎる」を「壊れている」と偽らない
 *
 * `looksCorrupt` が当たらない失敗(disk 容量など)は**そのまま投げ直す** ──
 * 何でも「壊れている」と読み替えると、user は在りもしない原因(SQL で直す等)を
 * 追うことになる(`image-export-limit.ts` の「別の理由まで大きすぎると言わない」
 * と同じ向き)。
 *
 * @returns 倒れなかった(`deps.rescue` が渡っていない / corrupt でない)ときは `null`
 */
async function fallbackToRescueArchive(
  deps: ExportDeps,
  iso: string,
  base: string,
  cause: unknown,
): Promise<{ out: ArchiveWriteOut; name: string; detail: string } | null> {
  if (!deps.rescue) return null;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!looksCorrupt(message)) return null;
  const { source, stats } = rescueArchiveSource({
    cid: deps.source.cid,
    title: deps.source.title,
    pick: deps.rescue.pick,
    // 🔑 つながり・履歴も拾えた分は入れる(#1087。作り直しと同じ口)
    pickRelations: deps.rescue.pickRelations,
    pickRevisions: deps.rescue.pickRevisions,
    // 🔑 添付の bytes を一緒に入れる(#1005 と同じ実体)。⚠ 無ければ入れないだけ
    ...(deps.rescue.assets === undefined ? {} : { assets: deps.rescue.assets }),
  });
  let out: ArchiveWriteOut;
  try {
    // 🔴 保険の zip は大きさで断らない(依頼 119-3。作り直しの保険と同じ向き)
    out = await writeArchive(source, iso, undefined, 'warn');
  } catch (e) {
    /**
     * 🔴 **拾い出しが 1 件も拾えなかった**(#1087)。⚠ そのまま投げると、壊れた保存領域の人が
     *   「書き出せるノートが 1 件もありません」を読む ── ノートを作っていないかのような字で、
     *   次の一手(保存領域の点検)に繋がらない。壊れの案内(`CORRUPT_REFUSAL`)を出す。
     * ⚠ 0 件以外の失敗(書けなかった等)は、そのまま投げる。
     */
    if (stats().entries === 0) throw new Error(CORRUPT_REFUSAL, { cause: e });
    throw e;
  }
  const s = stats();
  /**
   * 🔴 **書き出せた枝でだけ記録する**(#986 段③と同じ規律)── 捨てる前の窓
   * (`container-reset.ts` の `resetExplainMessage`)が「この画面で何件拾えたか」を
   * 出すための唯一の材料である。⚠ **頼んだ時点で記録しない**(落ちた回も
   * 「済み」に見えてしまう)── だからここ(成功した後)でだけ呼ぶ。
   */
  noteRescueWritten(s, Date.now());
  // 🔑 §5 の検算:入れたなら件数で、読めなかったなら「入っていません」と言う(字の組みは 1 か所)
  const detail = rescueArchiveDetail(s);
  return { out, name: archiveFileName(base, 'part'), detail };
}

/**
 * 添付 bytes を読むたびに進み具合を知らせる包み。⚠ 元の `source` は変えない(prototype で委譲する)。
 * 総数は `listAssetMetas` が返した件数。同じ添付を 2 度読む書き出しがあっても総数を超えない。
 */
function withAssetProgress(
  source: ArchiveSource,
  report: (done: number, total: number) => void,
  /** 🔴 やめる印(依頼 253)。立っていれば、次の読みで抜ける(読み出しの区切り)。 */
  token?: CancelToken,
): ArchiveSource {
  let total = 0;
  let done = 0;
  return Object.assign(Object.create(source) as ArchiveSource, {
    listAssetMetas: async () => {
      const metas = await source.listAssetMetas();
      total = metas.length;
      return metas;
    },
    listBodies: async (...args: Parameters<ArchiveSource['listBodies']>) => {
      token?.throwIfCancelled();
      return source.listBodies(...args);
    },
    getAssetBlob: async (key: string) => {
      token?.throwIfCancelled();
      const blob = await source.getAssetBlob(key);
      done = Math.min(done + 1, total);
      report(done, total);
      return blob;
    },
  });
}

/**
 * 書き出してダウンロードさせる。
 * @returns 書き出した entry 数(失敗時は null)
 */
export async function exportArchive(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  kind: ExportKind = 'archive',
  /** 呼び出し側が先に見つけた注意(1 ノート書出しの「関連は落ちる」等)。 */
  extraWarnings: readonly string[] = [],
  /**
   * 🔴 **file 名の末尾を決める**(#1017 段④b)。既定は `'full'`(コレクション
   * 全体)── `exportEntry` / `exportFolder` は `'notes'` を渡す。
   */
  archiveScope: ArchiveScope = 'full',
): Promise<number | null> {
  /**
   * 🔴 **進行中の字を出している間だけ true**(#1017 C5)。⚠ 直す前は、失敗しても
   *   「書き出しています…」が画面下に**残った**(エラーの行と並んで「まだ続いている」と読める)。
   *   失敗の出口は全部この `fail` を通るので、**ここで 1 度だけ**消す。
   * ⚠ 進行中の字を出す前の断り(編集中など)は消さない ── 別の知らせを巻き込まない。
   */
  let progressShown = false;
  const fail = (msg: string): null => {
    if (progressShown) deps.notify?.('');
    progressShown = false;
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return null;
  };
  // 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  const blocked = exportBlockedNote(dispatcher.getState(), '書き出してください');
  if (blocked !== null) return fail(blocked);

  deps.notify?.(EXPORT_STARTING[kind]);
  progressShown = true;
  const token = deps.job?.start('export') ?? null;
  try {
    // 🔴 直前の保存が disk に着いてから読む(読みは書込の chain の外に居る)
    await deps.settle();
    const now = deps.now?.() ?? new Date();
    const base = `${safeName(deps.source.title)}-${stamp(now)}`;
    const iso = now.toISOString();
    /**
     * 🔑 添付を 1 件ずつ読むたびに「(添付 N / M)」を出す(間引きつき)。添付が数百件あると、
     *   最初の「書き出しています…」が最後まで残って、止まって見えた。数えるのは `getAssetBlob` の呼び出し。
     */
    const startingText = EXPORT_STARTING[kind].replace(/…$/, '');
    const src = withAssetProgress(
      deps.source,
      createProgressThrottle((n, m) => deps.notify?.(`${startingText}(添付 ${n} / ${m})`)),
      token ?? undefined,
    );

    let out: ArchiveWriteOut;
    let name: string;
    let detail: string;
    if (kind === 'html') {
      out = await writePortableHtml(
        src,
        iso,
        deps.renderBody,
        deps.allowExternalImages === true,
        deps.pageFormat ?? DEFAULT_PAGE_FORMAT,
        deps.proseAlign ?? DEFAULT_PROSE_ALIGN,
        deps.askSql,
        // 🔴 図とグラフは、Word / PowerPoint と同じ産出器で絵にして埋め込む(#1648)
        { vector: deps.renderFigureVector, raster: deps.renderFigure },
      );
      name = `${base}.html`;
      // ⚠ **可逆ではない**ことをその場で言う(後から見分けられない形にしない ──
      // PKC2 は light / full の別を manifest にしか書いておらず user が困っていた)
      detail = `${out.counts.entries} 件(添付 ${out.counts.assets})、閲覧用(取り込み直せません)`;
    } else {
      /**
       * 🔴 **『バックアップ』『Markdown』は、保存領域に問題があるとき自動で
       * 倒れる**(#1017 段④b)。⚠ 倒れるのは `archiveScope === 'full'` のときだけ
       * (1 ノート・フォルダの書出しは対象にしない ── `ExportDeps.rescue` の
       * docstring と同じ理由)。
       */
      try {
        if (kind === 'markdown') {
          const md = await writeMarkdownZip(src, iso);
          out = md;
          name = `${base}.md.zip`;
          detail = `${md.counts.entries} 件(${describeMarkdownExport(md).assets})${describeMarkdownExport(md).tail}`;
        } else {
          out = await writeArchive(src, iso);
          name = archiveFileName(base, archiveScope);
          const c = out.counts;
          detail = `${c.entries} 件(つながり ${c.relations} / 履歴 ${c.revisions} / 添付 ${c.assets})`;
          /**
           * 🔴 **普通に書き出せた「バックアップ」も、「拾えた」に数える**
           * (#1017 段④b。#986 段③との配線を壊さないための直し)。
           *
           * ⚠ 「戻せる形で書き出す」という専用ボタンを退役させたので、
           *   `noteRescueWritten` を呼ぶ場所が**ここしか無くなった**
           *   (もう一方は `fallbackToRescueArchive`)。呼ばなくなると、
           *   健全な入れ物では「入れ物を捨てる」画面が**永久に
           *   「まだ拾い出していません」と言い続ける**(#986 の門が
           *   二度と開かない)── コレクション全体のバックアップは
           *   `container-reset.ts` の言う「戻せる形」そのものなので、
           *   ここで記録してよい。⚠ **`archiveScope === 'full'` のときだけ**
           *   (1 ノート・フォルダの書出しは「捨てる」の代わりにならない)。
           */
          if (archiveScope === 'full') {
            noteRescueWritten(
              {
                entries: c.entries,
                skipped: 0,
                empty: 0,
                bodyMissing: 0,
                assets: c.assets,
                assetBytes: 0,
                assetMissing: 0,
              },
              now.getTime(),
            );
          }
        }
      } catch (e) {
        // 🔴 やめた回を「保存領域の問題」と読んで、読めた分だけのバックアップに切り替えない(依頼 253)
        if (isOperationCancelled(e)) throw e;
        const fb =
          archiveScope === 'full' ? await fallbackToRescueArchive(deps, iso, base, e) : null;
        if (fb === null) throw e;
        out = fb.out;
        name = fb.name;
        detail = fb.detail;
      }
    }
    // 🔴 組み終えた後にやめられても、ダウンロードは始めない(依頼 253)
    token?.throwIfCancelled();
    deps.download(name, out.blob);
    const notes = [...extraWarnings, ...out.warnings];
    deps.report(notes);
    progressShown = false; // ⚠ 次の「書き出しました」が進行中の欄を空にする(`status-lifetime.ts` ── 結果は進行中の終わりでもある)
    // 🔴 **ファイル名を言う**(依頼 38-4 の裁定 B。#1643)── SQL の書き出しは名前を言っているのに、バックアップは
    //   言わず、保存したファイルをブラウザのダウンロード欄から探すとき手掛かりが無かった
    deps.notify?.(
      notes.length > 0
        ? `書き出しました: 「${name}」 ${detail}(注意 ${notes.length} 件)`
        : `書き出しました: 「${name}」 ${detail}`,
    );
    return out.counts.entries;
  } catch (e) {
    if (isOperationCancelled(e)) {
      // 🔴 やめた(依頼 253)── 失敗ではない(`OP_FAILED` は出さない)。ファイルは作っていない
      progressShown = false; // 次の知らせが進行中の欄を空にする
      deps.notify?.('書き出しをやめました(ファイルは作っていません)');
      return null;
    }
    return fail(`書き出しに失敗しました: ${errorText(e)}`);
  } finally {
    if (token !== null) deps.job?.finish(token);
  }
}

/**
 * 🔴 **md 書き出しの結果の言い方(zip とフォルダで 1 本)**(#1455 (b)レビュー)。
 * ⚠ 「取り込み直せません」と**何が落ちたか**(つながり / 履歴)は、書き出し先に依らず言う。
 * 🔑 **何が落ちたかを件数で言う**(設計 doc §3-2)。PKC2 は落ちたことを言わずに出していた。
 */
export function describeMarkdownExport(md: {
  counts: { assets: number; historyAssets: number };
  dropped: { relations: number; revisionEntries: number };
}): { assets: string; tail: string } {
  const lost: string[] = [];
  if (md.dropped.relations > 0) lost.push(`つながり ${md.dropped.relations}`);
  if (md.dropped.revisionEntries > 0) lost.push(`履歴 ${md.dropped.revisionEntries} 件ぶん`);
  // 🔴 控え(過去の版)の件数を出す(#213 / user 裁定 A 2026-08-16)── 減らすのではなく**言う**
  const assets =
    md.counts.historyAssets > 0
      ? `添付 ${md.counts.assets}(うち過去の版 ${md.counts.historyAssets})`
      : `添付 ${md.counts.assets}`;
  return {
    assets,
    tail: `。取り込み直せません` + (lost.length > 0 ? `(${lost.join(' / ')}が落ちます)` : ''),
  };
}

/**
 * 🔴 **PC のフォルダへ書く前の確認 + 選択**(#1455 (b))。
 *
 * ⚠ **選択ウィンドウは asset gate の外**で開く(選んでいる間、添付の取り込み / 削除を止めない)。
 *   ただし**押した直後の最初の await**にする(ユーザー操作の効力が切れる前に開く)。
 * ⚠ 二度押しは**自前の旗**で断る(gate の「添付の処理が実行中」では嘘になる)。
 * ⚠ ノートが 0 件なら、選ばせる前に断る(空のフォルダを作らない)。
 * @param run 選んだ後の書き出し(呼び側が asset gate に入れる)
 */
export function createMarkdownFolderFlow(
  dispatcher: Dispatcher,
  picker: FolderWritePicker,
  run: (root: WritableDirLike) => Promise<void>,
): () => Promise<void> {
  let busy = false;
  return async () => {
    if (busy) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: 'Markdown をフォルダに書き出している途中です。終わってから、もう一度押してください',
      });
      return;
    }
    const state = dispatcher.getState();
    const blocked = exportBlockedNote(state, '書き出してください');
    if (blocked !== null) {
      dispatcher.dispatch({ type: 'OP_FAILED', error: blocked });
      return;
    }
    // ⚠ メタが読めている(起動済み)状態の件数。0 件なら選ばせない
    if (state.entryMetas.size === 0) {
      dispatcher.dispatch({
        type: 'OP_FAILED',
        error: '書き出せるノートが 1 件もありません。ノートを作ってから押してください',
      });
      return;
    }
    busy = true;
    try {
      let root: WritableDirLike;
      try {
        root = await picker({ mode: 'readwrite' });
      } catch (e) {
        if (isPickerCancel(e)) return;
        dispatcher.dispatch({
          type: 'OP_FAILED',
          error: `書き出し先のフォルダを開けませんでした: ${errorText(e)}`,
        });
        return;
      }
      await run(root);
    } finally {
      busy = false;
    }
  };
}

/**
 * 🔴 **Markdown を PC のフォルダへ 1 度だけ書き出す**(#1455 (b))。選んだ後の書き出し部。
 *
 * zip の「Markdown で書き出す」と**同じ中身**(`writeMarkdownTo` 1 本)を、選んだフォルダの
 * 中の**新しいサブフォルダ**へ 1 file ずつ書く。憶えない・同期しない・上書きしない
 * (`md-folder-export.ts`)。選ぶところは `createMarkdownFolderFlow`。
 * ⚠ 保存領域が壊れているときの自動の拾い出し(`rescue`)は**持たない**。
 */
export async function exportMarkdownToFolder(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  root: WritableDirLike,
): Promise<number | null> {
  // 🔴 選ぶウィンドウを開いている間に章の欄などが開くことがある ── 書く直前にもう一度断る
  const blocked = exportBlockedNote(dispatcher.getState(), '書き出してください');
  if (blocked !== null) {
    dispatcher.dispatch({ type: 'OP_FAILED', error: blocked });
    return null;
  }
  deps.notify?.('Markdown をフォルダに書き出しています…');
  let sub: string | null = null;
  let sink: FolderSink | null = null;
  try {
    await deps.settle();
    const now = deps.now?.() ?? new Date();
    const base = `${safeName(deps.source.title)}-${stamp(now)}`;
    const fresh = await createFreshSubfolder(root, base);
    sub = fresh.name;
    sink = folderSink(fresh.dir);
    const md = await writeMarkdownTo(deps.source, now.toISOString(), sink);
    deps.report(md.warnings);
    const d = describeMarkdownExport(md);
    deps.notify?.(
      `${md.counts.entries} 件のノートを『${sub}』に書き出しました(${d.assets})${d.tail}` +
        (md.warnings.length > 0 ? `(注意 ${md.warnings.length} 件)` : ''),
    );
    return md.counts.entries;
  } catch (e) {
    deps.notify?.('');
    // 🔴 「残っています」と言うのは 1 file でも書けたときだけ
    const where =
      sub === null
        ? ''
        : sink !== null && sink.written > 0
          ? `。すでに書いた分は『${sub}』に残っています`
          : `。『${sub}』は作りましたが、中身は空です`;
    const what =
      e instanceof FolderWriteError
        ? `『${e.path}』を書けませんでした(${e.message})${where}` +
          (e.mayRemain ? `。『${e.path}』は空のまま残っているかもしれません` : '')
        : `${errorText(e)}${where}`;
    dispatcher.dispatch({ type: 'OP_FAILED', error: `書き出しに失敗しました: ${what}` });
    return null;
  }
}

/**
 * 🔴 **書き出す先の Office 形式**(#187 段⑤)。
 *
 * ⚠ **Word と PowerPoint で違うのはここに書いた 4 つだけ**である ── 本文の読み方も、
 * 画像の入れ方も、図の焼き方もまったく同じなので、**1 本の道**を通す
 * (CLAUDE.md §7「同じ判定が 2 か所に生えたら、規則を 1 つに寄せる」)。
 */
interface OfficeTarget {
  /** 依頼の種別(`ooxml-assemble.ts` が読む)。 */
  readonly kind: 'docx' | 'pptx';
  /** user に見せる呼び名。⚠ 断り文と知らせに出る。 */
  readonly app: string;
  /** 落とす file の拡張子。 */
  readonly ext: string;
  /** `:::if{format=X}` と突き合わせる字。 */
  readonly format: string;
}

const WORD: OfficeTarget = { kind: 'docx', app: 'Word', ext: 'docx', format: 'docx' };
const POWERPOINT: OfficeTarget = {
  kind: 'pptx',
  app: 'PowerPoint',
  ext: 'pptx',
  format: 'pptx',
};

/**
 * 🔴 **本文 → 塊 + bytes**(#187 段⑤ で Word / PowerPoint の共通部として括り出した)。
 *
 * 🔑 **画面と同じ HTML から組む**(設計 doc の (b))── `renderBody` は閲覧用 HTML と
 * **同じ口**である。PKC2 はここを別のレンダラにしたせいで「Word で直した」が
 * PDF に届かず、記録されている不具合がほぼ全部その土台に乗っていた。
 *
 * ⚠ 返す `media` の名前は**形式の根からの相対**(`media/image1.png`)である ──
 * `word/` か `ppt/` を前に付けるのは `ooxml-assemble.ts` の仕事
 * (置く場所と rels の指す先を**同じ file で**決める)。
 *
 * @returns 断られたときは `null`(理由は既に `fail` が出している)
 */
async function collectOfficeBlocks(
  deps: ExportDeps,
  /**
   * ⚠ **解決済みの描画の口を受け取る** ── `deps.renderBody` は省略可なので、
   * ここで改めて見ると**同じ判定が 2 か所**に生える(CLAUDE.md §7)。
   * 断るのは呼び側(知らせを出す前に断りたいので、判定はそちらに要る)。
   */
  renderBody: NonNullable<ExportDeps['renderBody']>,
  lid: string,
  target: OfficeTarget,
  fail: (msg: string) => false,
): Promise<{
  blocks: DocxBlock[];
  media: OoxmlMedia[];
  title: string;
  /**
   * 🔴 **読めなかった添付の注意**(#636)。⚠ 閲覧用 HTML は 2026-08-06 から
   *   積んでいたのに、Word / PowerPoint は `onSkip` を渡しておらず **0 件**だった
   *   ── マニュアルには「書き出すときに理由が残る」と書いて出荷していた。
   * ⚠ **optional にしない** ── `report` と同じ理由(配線が落ちても tsc が黙ると、
   *   user が見るのは「どの添付が欠けたか」が消えた形である)。
   */
  warnings: string[];
  /** 🔴 段落の中で入れられなかった物の呼び名(#1087)。⚠ 組み立てへ渡さないと注意の件数から抜ける。 */
  inlineSkipped: string[];
} | null> {
  /**
   * 🔴 **直前の保存が disk に着いてから読む**(2026-08-17 実測)。
   * ⚠ `phase === 'ready'` は「編集を終えた」しか言っていない ── 本文の書込は
   * その後ろで飛んでいて、ここの `getBody` は**それを追い越す**。
   */
  await deps.settle();
  // ⚠ 1 件だけの読み口(P6f)。⚠ 省略可なので**在ることを確かめてから**呼ぶ
  if (!deps.source.getBody) {
    fail('本文を読む機能が渡っていません');
    return null;
  }
  const body = await deps.source.getBody(lid);
  if (body === null) {
    fail('ノートが見つかりませんでした');
    return null;
  }
  const metas = await deps.source.listEntryMetas();
  const title = metas.find((m) => m.lid === lid)?.title ?? 'ノート';
  /**
   * 🔴 **詳細ペインと同じ材料を渡す**(#187 段③。閲覧用 HTML が 2026-08-06 に
   * 直したのと**同じ穴**が、Word 側に残っていた)。直す前は `render(body)` だけで:
   * - **frontmatter が本文として出る**(`---` が水平線、`key: value` が見出しに)
   * - `{{vars.x}}` が**生のまま**載る
   * - `heading-number: true` の文書に**番号が付かない**
   * ⚠ どれも**全文 body**(frontmatter 込み)から取る ── 読み飛ばした本文からは
   *   frontmatter が見えない。
   */
  const skip = body.length - parseFrontmatter(body).body.length;
  /**
   * 🔴 **囲みが指している添付を、字として焼き込む**(#444 段②)。
   *
   * ⚠ ここは**画面の DOM を読んでいない** ── 上のとおり**もう一度描いて**から
   *   塊に畳むので、画面で hydrator が埋めた字はここには来ない。渡さないと
   *   Word / PowerPoint だけ「この囲みの中身は添付に在ります」が残る。
   * ⚠ 読めなかったものは束に入らない ── 器のまま理由が出る(黙って空にしない)。
   */
  const warnings: string[] = [];
  const fenceAssets = await readFenceAssets(
    (k) => deps.source.getAssetBlob(k),
    collectFenceAssetKeys(body.slice(skip)),
    (k, why) =>
      warnings.push(`コードブロックが指している添付を埋め込めませんでした(${k}): ${why}`),
  );
  // 🔑 ノートへのリンクは Word / PowerPoint の先では開けない ── zip・HTML と同じ数え方・同じ文面(#1087)
  const linkNotice = noteLinkNotice(countNoteLinks(body));
  if (linkNotice !== null) warnings.push(linkNotice);
  const rendered = await renderBody(body.slice(skip), {
    vars: extractVars(body),
    headingNumber: extractHeadingNumberConfig(body),
    ...(Object.keys(fenceAssets).length > 0 ? { fenceAssets } : {}),
    /**
     * 🔴 **`:::if{format=docx}` / `:::if{format=pptx}` を生かす**(#187 段⑤)。
     * ⚠ ここを渡すまで、この記法は**受理はするが永久に不可視**だった
     *   (描画は `'html'` 固定)── 出口ができたので落ちていた動線が戻る。
     */
    format: target.format,
  });
  /**
   * 🔴 **本文に埋め込んだ SQL の答えを、書き出した時点の表にして入れる**(#1223 Q3 = B)。
   * ⚠ ここも**画面の DOM を読んでいない**(もう一度描いている)ので、画面で埋めた答えは
   *   来ない ── 焼かないと Word / PowerPoint だけ答えの表が無い。原文の SQL は枠として残る。
   */
  const baked = await bakeSqlEmbeds(rendered, deps.askSql);
  // 🔴 板に置いたノートは、Word には題名の 1 行を入れる(消えていた。中身は入れない ── #1163 依頼 278 = A)。PowerPoint は付箋の形のまま
  const html =
    target.kind === 'docx'
      ? insertPlacedNoteTitles(baked, (id) => metas.find((m) => m.lid === id)?.title ?? null, 'word')
      : baked;
  // ⚠ `<body>` で包む ── 包まないと happy-dom / 実ブラウザで木の形が揃わない
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const { blocks, images, figures, inlineSkipped } = htmlToDocxBlocks(doc);
  // 🔑 数式は Word / PowerPoint では打った字のまま入る ── 閲覧用 HTML と同じ文面で言う(#1087)
  const mathNotice = mathSourceNotice(doc.querySelectorAll('[data-pkc-math-src]').length);
  if (mathNotice !== null) warnings.push(mathNotice);
  // 🔑 別のノートの内容の埋め込みも、Word / PowerPoint では説明の字だけが残る ── 閲覧用 HTML と同じ文面で言う(#1648)
  const embedNotice = embedSourceNotice(doc.querySelectorAll('[data-pkc-embed-ref]').length);
  if (embedNotice !== null) warnings.push(embedNotice);
  // 🔑 名前の無い変数は字のまま残る ── 画面では色で見えるが、Word / PowerPoint では見えないので数えて言う(#1163 依頼 281)
  const varNotice = undefinedVarNotice(doc.querySelectorAll('.pkc-variable-undefined').length);
  if (varNotice !== null) warnings.push(varNotice);
  /**
   * 🔴 **添付の画像を入れる**(#187 段②)。
   * ⚠ **縦横比を保つ**ため、実寸を取ってから渡す(PKC2 は全画像を 480×360 px に
   *   潰していた)。⚠ 取れなかったものは `skipped` のまま残す ── **黙って
   *   落とさない**(本文にその場所と理由が出る)。
   * ⚠ bytes は **Blob のまま** zip へ渡す(heap に載せない ── 不可侵指示 2026-07-27)。
   */
  const media: OoxmlMedia[] = [];
  for (const [i, img] of images.entries()) {
    const blob = await deps.source.getAssetBlob(img.assetKey).catch(() => null);
    if (!blob) continue;
    const type = blob.type || 'image/png';
    // ⚠ Office が素で読める形だけ入れる(読めない形を入れると file ごと開けない)
    const ext = /jpe?g/.test(type)
      ? 'jpeg'
      : type.includes('gif')
        ? 'gif'
        : type.includes('webp')
          ? 'webp'
          : type.includes('png')
            ? 'png'
            : null;
    if (ext === null) {
      blocks[img.at] = {
        kind: 'skipped',
        what: `画像「${img.alt}」`,
        why: `この形式は ${target.app} に入れられません(${type})`,
      };
      continue;
    }
    const size = await imageSizeOf(blob);
    if (size === null) {
      blocks[img.at] = {
        kind: 'skipped',
        what: `画像「${img.alt}」`,
        why: '大きさを読めませんでした',
      };
      continue;
    }
    const name = `media/image${i + 1}.${ext}`;
    blocks[img.at] = {
      kind: 'image',
      media: name,
      widthPx: size.w,
      heightPx: size.h,
      alt: img.alt,
      // 🔴 本文で指した大きさ・寄せ(#1640 ③)
      ...(img.look?.widthPct !== undefined ? { widthPct: img.look.widthPct } : {}),
      ...(img.look?.align !== undefined ? { align: img.look.align } : {}),
    };
    media.push({ name, blob });
  }
  /**
   * 🔴 **図とグラフを焼いて入れる**(#187 段②)。
   *
   * ⚠ これが無いと、器の中の**原文が等幅の文字**として出る ── PKC2 で
   *   「図は原文が黙って出る」と記録されている失敗そのものである。
   * 🔑 焼くのは**画面と同じ産出器**(`mermaid-hydrate` / `chart-raster`)──
   *   別に描くとレンダラが 2 本になる(設計 doc §1-2 の失敗の根)。
   * ⚠ 大きさは **CSS px** で渡す ── 焼いた PNG は dpr 倍の画素を持つので、
   *   画素数をそのまま渡すと Retina の端末でだけ図が 2 倍で出る。
   */
  for (const [i, fig] of figures.entries()) {
    const what = fig.kind === 'chart' ? 'グラフ' : '図';
    /**
     * 🔴 **まずベクタ(EMF)で試す**(#238)。⚠ これが本命 ── 拡大しても
     * 粗くならず、図形として触れる。
     * ⚠ **落ちたらラスタへ落とす**(下)。ベクタで書けない図のために
     * 「図が消える」を作らない。
     */
    // 🔴 Word・PowerPoint は白いページ ── 画面の配色によらず明るい配色で描く(#1163 依頼 233。`true` = 紙の配色)
    // 🔴 ` ```svg ` の囲み(`kind: 'svg'`)は原文がそのまま SVG ── 描かずに、その字を EMF にする(#1163 依頼 235)
    const svg =
      fig.kind === 'svg' ? fig.source : await deps.renderFigureVector(fig.kind, fig.source, true).catch(() => null);
    if (svg !== null) {
      try {
        const emf = svgToEmf(svg);
        const vname = `media/figure${i + 1}.emf`;
        blocks[fig.at] = {
          kind: 'image',
          media: vname,
          widthPx: emf.widthPx,
          heightPx: emf.heightPx,
          alt: what,
        };
        media.push({ name: vname, blob: new Blob([emf.bytes as BlobPart]) });
        continue;
      } catch {
        // ⚠ 黙って消さない ── ラスタで入れ直す
      }
    }
    const drawn = await deps.renderFigure(fig.kind, fig.source, true).catch(() => null);
    const size = drawn === null ? null : await imageSizeOf(drawn.blob);
    if (drawn === null || size === null) {
      blocks[fig.at] = { kind: 'skipped', what, why: '描けませんでした' };
      continue;
    }
    const name = `media/figure${i + 1}.png`;
    blocks[fig.at] = {
      kind: 'image',
      media: name,
      widthPx: drawn.cssWidth,
      // ⚠ 高さは**焼いた絵の比**から出す(器の高さではない)
      heightPx: Math.max(1, Math.round((size.h * drawn.cssWidth) / size.w)),
      alt: what,
    };
    media.push({ name, blob: drawn.blob });
  }
  return { blocks, media, title, warnings, inlineSkipped };
}

/**
 * 🔴 **このノートを Word(.docx)で書き出す**(#187 段①)。
 *
 * ⚠ **1 ノート = 1 文書**にする。Word の文書は「1 本の文書」なので、
 * 何百件を 1 つに連ねる形は user の期待と違う(バックアップは `.pkc3.zip` が持つ)。
 */
export async function exportEntryDocx(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  lid: string,
): Promise<boolean> {
  return exportEntryOffice(dispatcher, deps, lid, WORD);
}

/**
 * 🔴 **このノートを PowerPoint(.pptx)で書き出す**(#187 段⑤)。
 *
 * ⚠ **Word とは切れ方が違う** ── H1 が扉、H2/H3 が新しいスライド、`---` で切れる
 * (設計 doc §3。PKC2 と同じ切れ方である)。
 */
export async function exportEntryPptx(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  lid: string,
): Promise<boolean> {
  return exportEntryOffice(dispatcher, deps, lid, POWERPOINT);
}

/**
 * 🔴 **このノートの本文を、そのまま 1 つの .md にして落とす**(#1440)。
 *
 * 🔑 **本文は 1 バイトも変えない** ── 方言の剥がしも frontmatter の付け足しも、`asset:` の書き換えも
 *   しない(コレクションの `.md.zip` が添付を相対パスへ書き換えるのとは別の物。あちらは zip の中に
 *   添付ごと入れるから書き換える。こちらは 1 file なので、書き換えると指す先が無い)。
 * ⚠ 読みは `getBody` 1 本(`singleEntrySource` は履歴と添付まで集めるので重い ── 要るのは本文だけ)。
 * ⚠ 題名と日付の規則は隣の Word / PowerPoint と同じ(`safeName` と `stamp`)── 規則を写さない。
 * 🔴 **添付は入らない**ので、本文が添付を指していれば**数えて言う**(黙って落とさない ── #213 の裁定 A と
 *   同じ向き)。⚠ 数えるのは**ノートが実際に指している添付**(`assetRefsIn`。GC・1 ノート書出しと同じ規則)。
 *   同じ添付を 2 か所で指していても 1 件、添付の一覧に無い key(切れた参照)は数えない。
 * @returns 書き出せたら true
 */
export async function exportEntryMarkdown(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  lid: string,
): Promise<boolean> {
  const fail = (msg: string): false => {
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return false;
  };
  // ⚠ 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  const blocked = exportBlockedNote(dispatcher.getState(), '書き出してください');
  if (blocked !== null) return fail(blocked);
  try {
    // 🔴 直前の保存が disk に着いてから読む(読みは書込の chain の外に居る)
    await deps.settle();
    const meta = (await deps.source.listEntryMetas()).find((m) => m.lid === lid);
    if (!meta) return fail('書き出すノートが見つかりません');
    const body = (await deps.source.getBody?.(lid)) ?? null;
    if (body === null) return fail('書き出すノートの本文を読めませんでした');
    const now = deps.now?.() ?? new Date();
    deps.download(`${safeName(meta.title)}-${stamp(now)}.md`, new Blob([body], { type: 'text/markdown' }));
    const keys = (await deps.source.listAssetMetas()).map((a) => a.key);
    const n = assetRefsIn(body, keys).length;
    const notes = n > 0 ? [`添付 ${n} 件は入っていません(バックアップなら入ります)`] : [];
    // 🔑 ノートへのリンクは外では開けない ── zip・フォルダと同じ数え方・同じ文面(`note-link-notice.ts`)。⚠ 本文は書き換えない
    const linkNotice = noteLinkNotice(countNoteLinks(body));
    if (linkNotice !== null) notes.push(linkNotice);
    deps.report(notes);
    deps.notify?.(
      notes.length > 0 ? `Markdown で書き出しました。${notes.join('。')}` : 'Markdown で書き出しました',
    );
    return true;
  } catch (e) {
    return fail(`書き出しに失敗しました: ${errorText(e)}`);
  }
}

/** Word / PowerPoint の**共通の道**(#187 段⑤)。 */
async function exportEntryOffice(
  dispatcher: Dispatcher,
  deps: ExportDeps,
  lid: string,
  target: OfficeTarget,
): Promise<boolean> {
  // 🔴 進行中の字を失敗のときに消す(#1017 C5。`exportArchive` の `fail` と同じ理由)
  let progressShown = false;
  const fail = (msg: string): false => {
    if (progressShown) deps.notify?.('');
    progressShown = false;
    dispatcher.dispatch({ type: 'OP_FAILED', error: msg });
    return false;
  };
  // ⚠ 編集中は draft が disk と違う ── 「保存したつもりの本文」が入らない形を作らない
  const blocked = exportBlockedNote(dispatcher.getState(), '書き出してください');
  if (blocked !== null) return fail(blocked);
  // ⚠ **知らせを出す前に断る** ── 「書き出しています…」の直後に断り文が出ると、
  //    user には「途中で失敗した」に見える(実際は 1 バイトも読んでいない)
  const renderBody = deps.renderBody;
  if (!renderBody) return fail('本文を作れませんでした(描画する機能が渡っていません)');
  deps.notify?.(`${target.app} で書き出しています…`);
  progressShown = true;
  try {
    const got = await collectOfficeBlocks(deps, renderBody, lid, target, fail);
    if (got === null) return false;
    // 🔴 本文が空のノート(フォルダ・添付だけのノートなど)は、中身の無い文書を落とさずに断る(#1163 依頼 143 = ②。ボタンの位置は変えない)
    if (got.blocks.length === 0) return fail(`本文が空なので、${target.app} には書き出しません`);
    const now = deps.now?.() ?? new Date();
    /**
     * 🔴 **組み立てと zip はワーカーで**(#187 段④。user 指示 2026-08-03 の不可侵)。
     * ⚠ 動かせるのはここだけ ── HTML の parse と走査は **DOM がワーカーに無い**
     *   ので動かせない(実測: 294KB でメインの詰まり 354ms のうち parse+走査が 129ms)。
     * ⚠ 紙面は画面の設定と同じ値を渡す(#187 段③)── 渡さないと Word だけ A4 縦。
     *   (スライドは版面が 16:9 固定なので、pptx は紙面を受け取らない)
     */
    const built = await buildOoxmlFile(
      target.kind === 'docx'
        ? {
            kind: 'docx',
            blocks: got.blocks,
            title: got.title,
            iso: now.toISOString(),
            pageFormat: deps.pageFormat ?? DEFAULT_PAGE_FORMAT,
            media: got.media,
            inlineSkipped: got.inlineSkipped,
          }
        : { kind: 'pptx', blocks: got.blocks, title: got.title, media: got.media, inlineSkipped: got.inlineSkipped },
    );
    deps.download(`${safeName(got.title)}-${stamp(now)}.${target.ext}`, built.blob);
    // 🔴 **落としたものは件数で言う**(#213 の裁定 A と同じ向き)
    // 🔴 **両方を出す**(#636)── 添付の注意はここでしか出ない(組み立て側は知らない)
    deps.report([...got.warnings, ...built.warnings]);
    // ⚠ 「書き出しました」は `notify`(一時の知らせ)で言う ── state の action に
    //    書き出し用の型は無い(増やさない)
    // ⚠ **数えて見せるものは形式で違う** ── スライドは「枚数」がいちばん効く
    // 🔴 Word は「ブロック」と言わない(画面のどこにも出てこない数え方。#1163 依頼 53-2 = A)── 画像があるときだけ括弧を付ける
    const how =
      'slides' in built.counts
        ? `(${built.counts.slides} 枚 / 画像 ${built.counts.images} 枚)`
        : built.counts.images > 0
          ? `(画像 ${built.counts.images} 枚)`
          : '';
    progressShown = false; // ⚠ 次の「書き出しました」が進行中の欄を空にする(結果は進行中の終わりでもある)
    deps.notify?.(`${target.app} で書き出しました${how}`);
    return true;
  } catch (e) {
    return fail(
      `${target.app} の書き出しに失敗しました: ${errorText(e)}`,
    );
  }
}

/**
 * 画像の**実寸**(px)。⚠ 取れなければ `null` ── 呼び側は**入れずに理由を残す**。
 *
 * 🔑 `createImageBitmap` を使う(`<img>` を作らない)── DOM に足さずに読め、
 * **すぐ `close()` して返せる**(不可侵指示 2026-07-27「生成物のライフサイクル
 * 終端で速やかに破棄」)。
 */
async function imageSizeOf(blob: Blob): Promise<{ w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return size.w > 0 && size.h > 0 ? size : null;
  } catch {
    return null;
  }
}
