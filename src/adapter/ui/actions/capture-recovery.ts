/**
 * 🔴 **途中で終わった録音・録画の復元**(#1985 項目 2。user 裁定 2026-11-20)。
 *
 * 起動のとき(`scan`)に控え(`capture-journal-store.ts`)を調べ、復元できる区間があれば
 * ①システムのメッセージに 1 件残し ②ステータスバーに静かな 1 行(押すと `open` = 復元する / 破棄する)を出す。
 * 判断(どの区間が復元できるか・並び・名前の連番)は `@features/capture/capture-journal.ts` の `planRecovery`。
 *
 * - 復元 = 区間の断片を 0 番から順につなぐ → `withRecordedDuration` で長さを書く → **録り始めたノート**へ
 *   添付として入れる(いまの収録と同じ道 `deliverRecovered`。編集中は預かる)。
 *   ⚠ そのノートが無ければ、添付だけを作って「見つからなかった」と言う(ノートは作らない ── 勝手にノートを増やさない)。
 * - 区間が添付になった時点で、その区間の控えを消す(`done`)。入れられなかった区間は控えを残す(次の機会に復元できる)。
 * - 破棄する = 控えを全部消す。
 */
import type { JournalStore } from '@adapter/platform/capture-journal-store';
import {
  planRecovery,
  recoveryAsk,
  recoveryMessage,
  type RecoverableSegment,
} from '@features/capture/capture-journal';
import { CAPTURE_LABEL } from '@features/asset/capture-text';
import type { CaptureService } from './capture';

export interface CaptureRecoveryDeps {
  readonly store: JournalStore;
  /** いまの保存先。⚠ 別の保存先の収録は出さない・触らない(同じ lid が別のノートを指すため)。 */
  readonly cid?: string;
  /** いま別のタブが録っている収録の id(その収録は「途中で終わった」ではない)。 */
  readonly liveIds: () => Promise<ReadonlySet<string>>;
  readonly service: Pick<CaptureService, 'deliverRecovered'>;
  /** システムのメッセージへ残す(ステータスバーに一時メッセージを置かない)。 */
  readonly post: (text: string) => void;
  readonly confirm: (
    message: string,
    opts: { okLabel: string; cancelLabel: string; danger: boolean },
  ) => Promise<boolean>;
  /** 一時の知らせ(結果の 1 行)。 */
  readonly notify: (text: string) => void;
  /** 復元できる区間の数が変わったとき(0 = 状態の行を畳む)。 */
  readonly onChange: (count: number) => void;
  /** `withRecordedDuration`(test は差し替える)。 */
  readonly withDuration: (blob: Blob, ms: number) => Promise<Blob>;
}

export interface CaptureRecovery {
  /** 起動のとき 1 度。復元できる区間の数を返す。 */
  scan(): Promise<number>;
  count(): number;
  /** 状態の行を押したとき: 復元する / 破棄する を聞く。 */
  open(): Promise<void>;
}

export function createCaptureRecovery(deps: CaptureRecoveryDeps): CaptureRecovery {
  let pending: RecoverableSegment[] = [];
  let busy = false;

  const set = (next: RecoverableSegment[]): void => {
    pending = next;
    deps.onChange(pending.length);
  };

  /** 区間の控えを消し、その収録の区間がもう無ければ身元も消す。 */
  const drop = async (seg: RecoverableSegment): Promise<void> => {
    try {
      await deps.store.dropSegment(seg.rec, seg.seg);
      set(pending.filter((p) => !(p.rec === seg.rec && p.seg === seg.seg)));
      if (!pending.some((p) => p.rec === seg.rec)) await deps.store.dropRec(seg.rec);
    } catch {
      // 消せなかった控えは、次の起動でまた出る
    }
  };

  const restoreOne = async (seg: RecoverableSegment): Promise<boolean> => {
    const chunks = (await deps.store.readSegment(seg.rec, seg.seg)).filter((c) => c.idx < seg.chunks);
    if (chunks.length !== seg.chunks) return false; // 読んでいる間に変わった ── 触らない
    // ⚠ 断片の Blob をそのままつなぐ(写さない)
    const joined = new Blob(
      chunks.map((c) => c.blob),
      { type: chunks[0]!.blob.type },
    );
    const blob = await deps.withDuration(joined, seg.elapsedMs);
    const r = await deps.service.deliverRecovered(
      blob,
      seg.kind,
      seg.part,
      new Date(seg.startedAt),
      seg.startedLid,
      () => void drop(seg),
    );
    return r !== 'failed';
  };

  return {
    count: () => pending.length,
    scan: async () => {
      try {
        const [metas, infos, live] = await Promise.all([
          deps.store.listMetas(),
          deps.store.listChunkInfos(),
          deps.liveIds(),
        ]);
        const mine = metas.filter((m) => deps.cid === undefined || m.cid === undefined || m.cid === deps.cid);
        const ids = new Set(mine.map((m) => m.id));
        const plan = planRecovery(
          mine,
          infos.filter((c) => ids.has(c.rec)),
          (id) => live.has(id),
        );
        // 掃除: 復元できない断片・断片の無い身元(書き手が落ちた跡)
        for (const u of plan.unrestorable) await deps.store.dropSegment(u.rec, u.seg).catch(() => undefined);
        for (const id of plan.emptyRecs) await deps.store.dropRec(id).catch(() => undefined);
        set([...plan.segments]);
        if (plan.segments.length > 0) deps.post(recoveryMessage(plan.segments.length));
        return plan.segments.length;
      } catch {
        // 置き場が開けない(私用ウィンドウなど)── 復元は出さない
        set([]);
        return 0;
      }
    },
    open: async () => {
      if (busy || pending.length === 0) return;
      busy = true;
      try {
        const targets = [...pending];
        const restore = await deps.confirm(recoveryAsk(targets), {
          okLabel: '復元する',
          cancelLabel: '復元しない',
          danger: false,
        });
        if (restore) {
          let ok = 0;
          for (const seg of targets) {
            try {
              if (await restoreOne(seg)) ok++;
            } catch {
              // この区間は残す(次の機会に復元できる)
            }
          }
          const rest = targets.length - ok;
          deps.notify(
            rest === 0
              ? `途中で終わった収録を ${ok} 区間、復元しました`
              : `途中で終わった収録を ${ok} 区間、復元しました(${rest} 区間は取り込めなかったので残しています)`,
          );
          return;
        }
        const discard = await deps.confirm(
          `途中で終わった${CAPTURE_LABEL.audio}・${CAPTURE_LABEL.screen}を破棄しますか。破棄すると取り消せません。`,
          { okLabel: '破棄する', cancelLabel: '残しておく', danger: true },
        );
        if (!discard) return;
        for (const rec of new Set(targets.map((t) => t.rec))) await deps.store.dropRec(rec).catch(() => undefined);
        set([]);
        deps.notify('途中で終わった収録を破棄しました');
      } finally {
        busy = false;
      }
    },
  };
}
