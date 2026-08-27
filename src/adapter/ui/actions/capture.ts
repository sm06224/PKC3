/**
 * 🔴 **録音・画面収録の段取り**(#413)。
 *
 * > user 要望 2026-07-16(PKC2 #922):
 * > 「**録音と画面収録をマルチメディアで埋め込めるようにする / これで、
 * > 会議メモをうまく残せるはず**」
 *
 * 押す → 帯が出る → 止める → **添付になって、開いていたノートに参照が入る**。
 *
 * ## 🔑 ここが持っている判断(`media-capture.ts` は「録るだけ」)
 *
 * - **同時に 1 本だけ**(2 本目は理由を出して断る)
 * - **止まったら user に見える** ── 自動停止も、ブラウザ側の「共有を停止」も
 * - 🔴 **選んでいたノートへ戻す** ── 添付を作ると `CREATE_ENTRY` が
 *   **選択を奪う**(`app-state.ts` の `selectedLid: action.lid`)。戻さないと
 *   「会議メモを書いていたのに、止めたら別の物が開いている」になる
 *   (user 指示 2026-08-22「**さっきまでやっていたことが消える**」)
 * - 🔴 **本文へ入れられない回は、黙らない** ── 編集中 / 追記できない種類 /
 *   ノートを選んでいない。⚠ **収録そのものは残っている**(添付になっている)ので、
 *   そこまで言い切る
 *
 * ⚠ **取り込み口は `attachOne` の 1 本**(`attach` として注入する)── 2 つ目を作らない。
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { formatAssetRef } from '@features/asset/asset-ref-format';
import { humanBytes } from '@features/asset/image-shrink';
import { captureBarLine, captureFileName, CAPTURE_LABEL } from '@features/asset/capture-text';
import { isAppendable } from '@features/flavor/append-spec';
import {
  startCapture as startCaptureImpl,
  type CaptureDeps,
  type CaptureEnd,
  type CaptureHandle,
  type CaptureKind,
} from '@adapter/platform/media-capture';
import type { AttachItem, AttachedOne } from './attach';

/**
 * 🔴 **ここまで積んだら自動で止める**(それまでの分は残す)。
 *
 * ⚠ **時間ではなく量で切る** ── 同じ 1 分でも、音だけと画面とでは桁が違う。
 *   ⚠ **何分ぶんかは書かない**(測っていない ── 符号化の速さはブラウザと
 *   画面の中身で変わる。CLAUDE.md「性能の主張は測ってから言う」)。
 * ⚠ **flag にしない**(枠は 15 個 ── 値を変える動機が user 側に無い)。
 * 🔑 これは「置き忘れ」を止める門であって、空き容量の門ではない ──
 *   そちらは `storeAsset` の quota preflight が別に持っている。
 */
export const MAX_CAPTURE_BYTES = 250 * 1024 * 1024;

export interface CaptureServiceDeps {
  readonly dispatcher: Dispatcher;
  /** bytes を添付にする口。⚠ **`attachOne` を通す**(2 つ目の取込口を作らない)。 */
  readonly attach: (item: AttachItem) => Promise<AttachedOne | null>;
  /** 帯を描き直す合図。⚠ `null` = 収録していない(帯を畳む)。 */
  readonly onChange: (line: string | null) => void;
  /** 一時の知らせ(エラーの行とは別)。 */
  readonly notify: (text: string) => void;
  /** ブラウザの口(test は fake を入れる)。 */
  readonly capture?: CaptureDeps;
  /** 収録を始める口。⚠ test はここを差し替える。 */
  readonly start?: typeof startCaptureImpl;
  /** いまの時刻(名前に使う)。⚠ `features/` と同じ約束で**外から渡す**。 */
  readonly now?: () => Date;
  /**
   * 1 秒ごとに合図を張る口。返り値は**外す関数**。
   * ⚠ test は手で撃つ(`setInterval` を待たない)。
   */
  readonly tick?: (fn: () => void) => () => void;
  readonly maxBytes?: number;
}

export interface CaptureService {
  /** 始める。⚠ 断るときは**理由を出す**(黙って no-op にしない)。 */
  start(kind: CaptureKind): Promise<void>;
  /** 止めて、添付にして、本文へ参照を入れる。 */
  stop(): void;
  /** 捨てる(添付にしない / 本文も触らない)。 */
  discard(): void;
  /** 帯に出す 1 行(収録していなければ `null`)。 */
  line(): string | null;
}

/** 既定の 1 秒刻み。⚠ 収録していない間は**張らない**(常駐を作らない)。 */
function intervalTick(fn: () => void): () => void {
  const id = setInterval(fn, 1000);
  return () => clearInterval(id);
}

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  const start = deps.start ?? startCaptureImpl;
  const now = deps.now ?? ((): Date => new Date());
  const tick = deps.tick ?? intervalTick;
  const maxBytes = deps.maxBytes ?? MAX_CAPTURE_BYTES;

  let handle: CaptureHandle | null = null;
  let untick: (() => void) | null = null;
  /**
   * 🔴 **取り込めるまで預かる収録**(2026-08-27、自分の fake が甘くて隠れていた)。
   *
   * ⚠ `CREATE_ENTRY` は **`phase !== 'ready'` を黙って捨てる**(`app-state.ts`)。
   *   つまり**編集中に収録が終わると、添付が 1 件もできない** ── そのまま捨てると
   *   **収録が丸ごと消えて、しかも何も言わない**(PKC2 の全損と同じ結果になる)。
   * 🔑 だから `Blob` のまま預かって、**編集が終わった瞬間に取り込む**。
   *   ⚠ bytes は heap の外なので、預かっても常駐は増えない。
   */
  const pending: Array<{ blob: Blob; kind: CaptureKind; why: string }> = [];
  let unwatch: (() => void) | null = null;
  /** 始めようとしている最中(許可を待っている)。⚠ **2 本目を防ぐ**。 */
  let starting = false;
  /** 片付けの最中。⚠ 「止める」と自動停止が重なっても 1 回しか片付けない。 */
  let closing = false;

  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });

  const line = (): string | null =>
    handle === null ? null : captureBarLine(handle.kind, handle.elapsedMs(), humanBytes(handle.bytes()));

  const paint = (): void => deps.onChange(line());

  /** 帯と刻みを畳む。⚠ **どの終わり方でも必ず通る**(帯が残ると「録り続けている」に見える)。 */
  const close = (): void => {
    untick?.();
    untick = null;
    handle = null;
    closing = false;
    paint();
  };

  /**
   * 🔴 **止まった理由は、結果と**同じ 1 行**に載せる**。
   *
   * ⚠ 別々に出すと**後の 1 行が前の 1 行を消す**(知らせの欄は 1 本)。
   *   さらに `OP_FAILED` に載せると**添付を作った瞬間に消える** ──
   *   `CREATE_ENTRY` の reducer が `error: null` を書くからである
   *   (この欠陥は test が撃って初めて見えた)。
   * ⚠ `stopped`(user が押した)だけは何も言わない ── 押した本人が知っている。
   */
  const whyStopped = (reason: CaptureEnd, kind: CaptureKind): string => {
    if (reason === 'too-large')
      return `${CAPTURE_LABEL[kind]}が上限(${humanBytes(maxBytes)})に達したので止めました。`;
    if (reason === 'shared-ended')
      /**
       * ⚠ **音でも来る** ── マイクが抜かれた / 許可が取り消されたときも
       *   track は `ended` を撃つ。「共有が終わった」とだけ書くと、
       *   録音していた user は**別の話をされている**と読む。
       */
      return kind === 'screen'
        ? '共有が終わったので画面収録を止めました。'
        : 'マイクが使えなくなったので録音を止めました。';
    return '';
  };

  /**
   * 添付にして、開いていたノートの本文へ参照を入れる。
   * ⚠ **入れ先は「取り込む時点で開いているノート」**。添付を作ると選択が奪われる
   *   ので、**先に控える**(後から読むと添付自身を指す)。
   */
  const ingest = async (blob: Blob, kind: CaptureKind, why: string): Promise<void> => {
    const state = deps.dispatcher.getState();
    const into = state.selectedLid;
    const archetype = into === null ? undefined : state.entryMetas.get(into)?.archetype;
    /**
     * ⚠ **`;codecs=opus` を落とす** ── 引数付きのまま持ち回ると、拡張子の逆引き
     *   (`EXT_MIME`)に当たらず書き出しの名前が `.bin` になる(#205 と同じ形)。
     */
    const mime = blob.type.split(';')[0]!.trim();
    const name = captureFileName(kind, now(), mime);
    const attached = await deps.attach({ name, type: mime, size: blob.size, blob });
    if (attached === null) {
      // ⚠ **黙って消さない** ── 空き不足なら `attachOne` が理由を出しているが、
      //   出していない断り方(reducer が捨てた等)もあるので、ここでも 1 行言う
      deps.notify(`${why}${CAPTURE_LABEL[kind]}を取り込めませんでした`);
      return;
    }

    // 🔴 **開いていたノートへ戻す**(添付が奪った選択を返す)
    if (into !== null && into !== attached.lid) {
      deps.dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: into });
    }

    const ref = formatAssetRef(name, `asset:${attached.assetKey}`, false);
    /**
     * 🔴 **入れられない回は、そこまで言う**(黙って落とさない)。
     * ⚠ どの場合も**収録は残っている** ── 「消えた」と読ませない。
     */
    if (into === null) {
      deps.notify(`${why}「${name}」を添付にしました(ノートを開いていないので本文には入れていません)`);
      return;
    }
    if (!isAppendable(archetype)) {
      deps.notify(`${why}「${name}」を添付にしました(開いているのは追記できない種類なので本文には入れていません)`);
      return;
    }
    const after = deps.dispatcher.getState();
    if (after.phase !== 'ready' || after.writeLock !== null) {
      deps.notify(`${why}「${name}」を添付にしました(いま本文を書けないので、本文には入れていません)`);
      return;
    }
    deps.dispatcher.dispatch({ type: 'APPEND_TO_ENTRY', lid: into, text: ref, heading: null, target: null });
    deps.notify(`${why}「${name}」を本文に入れました`);
  };

  /**
   * 🔴 **編集が終わるまで預かる**(捨てない)。
   * ⚠ 見張りは**1 本だけ**張って、取り込んだら外す ── 張りっぱなしにすると
   *   以後の全 dispatch でここを通る(常駐を作らない)。
   */
  const hold = (blob: Blob, kind: CaptureKind, why: string): void => {
    // ⚠ **積む**(1 枠にしない)── 編集の最中に 2 本目を録って、それも強制的に
    //    終わることがある。1 枠だと**先に預かったほうが黙って消える**。
    pending.push({ blob, kind, why });
    deps.notify(`${why}${CAPTURE_LABEL[kind]}を預かりました(編集を終えると、開いているノートに入れます)`);
    // ⚠ 見張りは**1 本だけ**(2 本張ると、同じ収録を 2 回取り込む)
    if (unwatch !== null) return;
    unwatch = deps.dispatcher.onState((s) => {
      if (s.phase !== 'ready') return;
      unwatch?.();
      unwatch = null;
      // ⚠ **取り出してから**回す ── 残したまま回すと、次の state で二重に取り込む
      const taken = pending.splice(0, pending.length);
      /**
       * 🔴 **その場で取り込まない**(2026-08-27、test が撃って判明)。
       *
       * ⚠ `Dispatcher` は**listener の中からの dispatch をキューに積む**
       *   (`draining` の間は自分の `pending` へ回す)。だからここで `attach` を
       *   呼ぶと、その中の `CREATE_ENTRY` は**まだ state に入っていない** ──
       *   `attachOne` は「作れたか」を `entryMetas` で確かめるので、
       *   **作れているのに「作れなかった」と読む**(添付だけ増えて、
       *   本文には入らず、user には「取り込めませんでした」と出る)。
       * 🔑 1 段ずらして、drain が終わってから取り込む。
       */
      queueMicrotask(async () => {
        // ⚠ **順に**(並べると、選択を戻す dispatch が互いを追い越す)
        for (const p of taken) await ingest(p.blob, p.kind, p.why);
      });
    });
  };

  /**
   * 止めて、添付にして、本文へ参照を入れる。
   * ⚠ **`reason` によらず同じ道を通る**(手で止めた回だけ別扱いにすると、
   *   自動停止の回が誰にも試されない ── CLAUDE.md §2「未実行の経路」)。
   */
  const finish = async (reason: CaptureEnd): Promise<void> => {
    const h = handle;
    if (h === null || closing) return;
    closing = true;
    /**
     * ⚠ **刻みを外すのは `close()` の 1 か所**。ここにも書いてあったが、
     *   変異試験 N6 が**外しても何も壊れない**ことを教えた ── `close()` は
     *   `h.stop()` の直後に走るので、この 2 行が効く窓は 1 刻みより短い
     *   (CLAUDE.md「『これが無いと壊れる』と書く前に、外して壊れるのを見る」)。
     */
    const why = whyStopped(reason, h.kind);
    const kind = h.kind;
    const blob = await h.stop();
    close();
    if (blob === null || blob.size === 0) {
      // ⚠ ここは本当に**失敗**である(何も残っていない)── エラーの行へ出す
      fail(`${why}${CAPTURE_LABEL[kind]}できませんでした(1 バイトも録れていません)`);
      return;
    }
    // 🔴 **編集中は添付が作れない** ── 捨てずに預かる(下の `hold`)
    if (deps.dispatcher.getState().phase !== 'ready') {
      hold(blob, kind, why);
      return;
    }
    await ingest(blob, kind, why);
  };

  return {
    line,
    start: async (kind) => {
      // ⚠ **同時に 1 本だけ**(2 本目は理由を出して断る)
      if (handle !== null || starting) {
        fail('すでに収録しています(先に止めてください)');
        return;
      }
      starting = true;
      try {
        handle = await start(kind, deps.capture ?? {}, {
          maxBytes,
          // ⚠ **自動停止も共有停止も、ここへ来る**(終わり方の口を 1 つにする)
          onEnd: (reason) => {
            if (reason !== 'discarded') void finish(reason);
          },
        });
      } catch (e) {
        // 🔴 権限拒否・非対応は**理由つきで**(`CaptureRefused` が文言を持っている)
        fail((e as Error).message);
        return;
      } finally {
        starting = false;
      }
      untick = tick(paint);
      paint();
    },
    stop: () => {
      if (handle === null) return;
      /**
       * 🔴 **編集中は止めない** ── 止めても添付が作れず、預かるしかない。
       * ⚠ user は「止めれば入る」と思って押すので、**入らないなら押させない**
       *   ほうが良い(収録は続いているので、何も失われない)。
       * ⚠ 手で止められない回(上限 / 共有停止)は `hold` が受ける。
       */
      if (deps.dispatcher.getState().phase !== 'ready') {
        fail('編集中は取り込めません。編集を終えてから止めてください(収録は続いています)');
        return;
      }
      void finish('stopped');
    },
    discard: () => {
      const h = handle;
      if (h === null) return;
      /**
       * ⚠ **門は 1 つだけ** ── 捨てた回に片付け(添付 / 本文)へ進まないのは
       *   `onEnd` の `reason !== 'discarded'` である。ここで `closing` も立てると
       *   **門が 2 つ**になり、理由の判定を壊しても救われて気づけない
       *   (変異試験 N3 が SURVIVED で教えた ── CLAUDE.md §1「救い手が変わっただけ」)。
       */
      h.discard();
      close();
      deps.notify(`${CAPTURE_LABEL[h.kind]}を捨てました`);
    },
  };
}
