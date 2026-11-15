/**
 * 🔴 **起動に失敗した画面の「バックアップ」**(#1163 依頼 208。user 回答「『再読み込み』と、読める範囲を取り出す
 * 『バックアップ』の両方を出す」)。
 *
 * 起動に失敗すると、いつもの「バックアップ」(左下)は画面に無い ── ノートを取り出す道が 1 つも無かった。
 * ここは保存領域を**もう一度開き直し**、拾い出し(`rescueEntries` などの `NOT INDEXED` の読み)で読める分だけを集めて、
 * いつもの拾い出しと同じ `.pkc3-part.zip` で保存する。
 *
 * 🔑 束ね方は保存領域に問題があるときの自動の倒れ先(`export-archive.ts` の `fallbackToRescueArchive`)と同じ 1 本
 *   (`rescueArchiveSource` + `writeArchive`)── 取り込めば戻せる形である。
 * ⚠ うまく動いていない保存領域にもう一度触ることになる(#1163 の設問で断った点)── 開き直しは起動と同じ `init` /
 *   `resolveContainer` を通り、拾い出しそのものは読むだけ。開けなかった / 1 件も読めなかったときは、そう言う。
 * ⚠ 起動に失敗したときは、起動が開いた口を先に閉じておく(main.ts の `bootStoreClient`)── 握ったままだと開き直せない。
 * ⚠ 開き直した口は**必ず閉じる**(閉じないと、再読み込みした後の起動が保存領域を取れない)。
 *
 * ⚠ main.ts はどの test からも実行されないので、判断はここに置き、main.ts は口を繋ぐだけにする(CLAUDE.md §2)。
 */
import { writeArchive } from '@features/export/pkc3-archive';
import { archiveFileName } from '@features/export/archive-kind';
import { safeName } from '@features/export/file-name';
import { dayStamp } from '@features/datetime/date-math';
import {
  rescueArchiveDetail,
  rescueArchiveSource,
  type RescueAssets,
  type RescuePick,
  type RescueRelationsPick,
  type RescueRevisionsPick,
} from '@features/storage/rescue-archive';

/** 開き直した保存領域の、拾い出しの口。 */
export interface BootRescueStore {
  /** 入れ物の id。⚠ 引けなければ `null`(添付は入れない ── 本文は入れる)。 */
  readonly cid: string | null;
  readonly pick: RescuePick;
  readonly pickRelations?: RescueRelationsPick;
  readonly pickRevisions?: RescueRevisionsPick;
  /** 開き直した口を閉じる。⚠ 失敗しても必ず呼ばれる。 */
  close(): void;
}

export interface BootRescueDeps {
  /** 保存領域を開き直す。⚠ 開けなければ投げる。 */
  open(): Promise<BootRescueStore>;
  /** 添付の bytes(IndexedDB。保存領域が壊れていても読める)。 */
  readonly assets?: RescueAssets;
  /** 入れ物の名前(ファイル名の頭)。 */
  readonly title: string;
  download(name: string, blob: Blob): void;
  readonly now?: () => Date;
  /**
   * 開き直しを待つ上限(ms。既定 30 秒)。⚠ 別のタブが保存領域を握っていると、開き直しが返らないことがある ──
   *   待ち続けると「集めています…」のまま押せなくなるので、過ぎたら「開けなかった」と言う。
   */
  readonly openTimeoutMs?: number;
}

/** 開けなかったとき。 */
export const BOOT_RESCUE_OPEN_FAILED = '保存領域を開けなかったため、バックアップを取れませんでした';
/** 1 件も読めなかったとき。 */
export const BOOT_RESCUE_EMPTY = '読めるノートがありませんでした(保存領域の中身を読めませんでした)';
/** 集めている間の字(画面に出す)。 */
export const BOOT_RESCUE_WORKING = '読める分を集めています…';

/**
 * 読める分を集めて保存する。
 * @returns 画面に出す 1 行(成功・失敗とも)。⚠ 投げない ── 失敗の画面の上でさらに投げると、押した人に何も返らない
 */
export async function bootRescueBackup(deps: BootRescueDeps): Promise<string> {
  let store: BootRescueStore;
  try {
    const opening = deps.open();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), deps.openTimeoutMs ?? 30_000);
    });
    const got = await Promise.race([opening, late]);
    clearTimeout(timer);
    if (got === null) {
      // ⚠ 遅れて開いた口は閉じる(握ったままにしない)
      void opening.then((s) => s.close(), () => undefined);
      return BOOT_RESCUE_OPEN_FAILED;
    }
    store = got;
  } catch {
    return BOOT_RESCUE_OPEN_FAILED;
  }
  try {
    const now = (deps.now ?? (() => new Date()))();
    const { source, stats } = rescueArchiveSource({
      cid: store.cid ?? '',
      title: deps.title,
      pick: store.pick,
      ...(store.pickRelations !== undefined && store.pickRevisions !== undefined
        ? { pickRelations: store.pickRelations, pickRevisions: store.pickRevisions }
        : {}),
      // 🔑 添付は入れ物の id が引けたときだけ(鍵は入れ物ごとに分かれている)
      ...(store.cid !== null && deps.assets !== undefined ? { assets: deps.assets } : {}),
    });
    let blob: Blob;
    try {
      // 🔴 保険の zip は大きさで断らない(自動の倒れ先と同じ向き)
      blob = (await writeArchive(source, now.toISOString(), undefined, 'warn')).blob;
    } catch {
      return stats().entries === 0 ? BOOT_RESCUE_EMPTY : '読めた分を書き出せませんでした';
    }
    const s = stats();
    if (s.entries === 0) return BOOT_RESCUE_EMPTY;
    const name = archiveFileName(`${safeName(deps.title)}-${dayStamp(now, '')}`, 'part');
    deps.download(name, blob);
    return `「${name}」を保存しました。${rescueArchiveDetail(s)}`;
  } finally {
    store.close();
  }
}
