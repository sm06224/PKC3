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
import { humanBytes } from '@features/human-bytes';
import { captureBarLine, captureFileName, CAPTURE_LABEL } from '@features/asset/capture-text';
import { elapsedText } from '@features/elapsed-text';
import { noteToPutInto, putAssetIntoNote } from './asset-into-note';
import {
  startCapture as startCaptureImpl,
  type CaptureDeps,
  type CaptureEnd,
  type CaptureHandle,
  type CaptureKind,
} from '@adapter/platform/media-capture';
import type { AttachItem, AttachedOne } from './attach';
import { createWritableQueue } from './writable-queue';

/**
 * 🔴 **1 本がここまで育ったら、切って次を始める**(#771)。⚠ **止めない**。
 *
 * > user 要望 2026-09-07:「**画面録画と録音に関して、途中終了はしてほしくない /
 * > 最大時間を１２時間にして、必要なら分割保存にしたい**」
 *
 * ⚠ **時間ではなく量で切る** ── 同じ 1 分でも、音だけと画面とでは桁が違う。
 *   空き容量の門(`attach.ts`)も IDB も**バイトで効く**ので、単位を揃える。
 *   ⚠ **何分ぶんかは書かない**(測っていない ── 符号化の速さはブラウザと
 *   画面の中身で変わる。CLAUDE.md「性能の主張は測ってから言う」)。
 * ⚠ **flag にしない**(枠は 15 個 ── 値を変える動機が user 側に無い)。
 * 🔑 これは「1 本を抱えたまま落ちて全損する」(PKC2)を止める門であって、
 *   空き容量の門ではない ── そちらは `storeAsset` の quota preflight が別に持っている。
 */
export const CAPTURE_PART_BYTES = 250 * 1024 * 1024;

/**
 * 🔴 **ここに達したら止める**(user 指示 2026-09-07「最大時間を１２時間にして」)。
 * ⚠ **上限を持たない**という選択はしない ── 置き忘れると、端末の空きを
 *   静かに食い尽くす(それは「途中終了」より悪い終わり方である)。
 */
export const MAX_CAPTURE_MS = 12 * 60 * 60 * 1000;

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
  /** 1 本を切る大きさ。⚠ test はここを小さくして「切れること」を見る。 */
  readonly partBytes?: number;
  /** 止める時間。⚠ test はここを短くして「12 時間で止まること」を見る。 */
  readonly maxMs?: number;
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
  const partBytes = deps.partBytes ?? CAPTURE_PART_BYTES;
  const maxMs = deps.maxMs ?? MAX_CAPTURE_MS;

  let handle: CaptureHandle | null = null;
  let untick: (() => void) | null = null;
  /**
   * 🔴 **始めた時刻**(#771)。⚠ 分かれた本は**全部この時刻 + 連番**で名乗る ──
   *   取り込んだ時刻で名乗らせると、3 本が一覧の**別々の場所**に並ぶ。
   */
  let startedAt: Date | null = null;
  /**
   * 🔴 **この収録の印**(#668 C)。⚠ 分かれた回は本文に N 行入るので、
   *   「元に戻す」1 回で**まとめて**消えないと、user が N 回押すことになる。
   */
  let batch: string | null = null;
  /**
   * 🔴 **取り込めるまで預かる収録**(2026-08-27、自分の fake が甘くて隠れていた)。
   *
   * ⚠ `CREATE_ENTRY` は **`phase !== 'ready'` を黙って捨てる**(`app-state.ts`)。
   *   つまり**編集中に収録が終わると、添付が 1 件もできない** ── そのまま捨てると
   *   **収録が丸ごと消えて、しかも何も言わない**(PKC2 の全損と同じ結果になる)。
   * 🔑 だから `Blob` のまま預かって、**編集が終わった瞬間に取り込む**。
   *   ⚠ bytes は heap の外なので、預かっても常駐は増えない。
   * 🔑 **預かりの仕掛けは `writable-queue.ts` の 1 本**(#279 で共有にした)──
   *   タイマーが同じ物を 2 本目に書くところだった(§7)。
   */
  const queue = createWritableQueue(deps.dispatcher);
  /** 始めようとしている最中(許可を待っている)。⚠ **2 本目を防ぐ**。 */
  let starting = false;
  /** 片付けの最中。⚠ 「止める」と自動停止が重なっても 1 回しか片付けない。 */
  let closing = false;

  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });

  const line = (): string | null =>
    handle === null
      ? null
      : captureBarLine(
          handle.kind,
          handle.elapsedMs(),
          humanBytes(handle.bytes()),
          /**
           * ⚠ **ここで 0 に倒さない** ── 倒すのは `elapsedText` の中 1 か所である
           *   (負を渡しても `0:00` が返る)。変異試験 C1 が「倒しても倒さなくても
           *   同じ」と教えたので、**同じ判定を 2 か所に置くのをやめた**(§7)。
           */
          maxMs - handle.elapsedMs(),
          // 🔑 `parts()` は**渡し終えた本数**なので、いま録っているのは +1 本目
          handle.parts() + 1,
        );

  const paint = (): void => deps.onChange(line());

  /** 帯と刻みを畳む。⚠ **どの終わり方でも必ず通る**(帯が残ると「録り続けている」に見える)。 */
  const close = (): void => {
    untick?.();
    untick = null;
    handle = null;
    closing = false;
    // ⚠ **次の収録へ持ち越さない**(名前の時刻・印は 1 回ぶんの物である)
    startedAt = null;
    batch = null;
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
    if (reason === 'too-long')
      return `${CAPTURE_LABEL[kind]}が上限(${elapsedText(maxMs)})に達したので止めました。`;
    /**
     * 🔴 **符号化が死んだ**(#771)。⚠ 直す前は受け口が **0 件**で、
     *   帯だけ伸び続けたまま**静かに短い file** になっていた ── だから
     *   「短くなった理由」を必ず字で出す。
     */
    if (reason === 'failed')
      return `${CAPTURE_LABEL[kind]}を続けられなくなったので止めました(ブラウザが収録を止めました)。`;
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
   * 🔑 選択を返す / 本文へ入れる / 書けないなら預かる、の 3 つは
   *   **`asset-into-note.ts` 1 か所**が持つ ── 添付の取込(`attachFiles`)も
   *   同じ口を通る(user 裁定 2026-09-02、#666)。
   */
  const ingest = async (
    blob: Blob,
    kind: CaptureKind,
    why: string,
    part: number | null,
    at: Date,
    tag: string | null,
  ): Promise<boolean> => {
    const into = noteToPutInto(deps.dispatcher);
    /**
     * ⚠ **`;codecs=opus` を落とす** ── 引数付きのまま持ち回ると、拡張子の逆引き
     *   (`EXT_MIME`)に当たらず書き出しの名前が `.bin` になる(#205 と同じ形)。
     */
    const mime = blob.type.split(';')[0]!.trim();
    const name = captureFileName(kind, at, mime, part);
    const attached = await deps.attach({ name, type: mime, size: blob.size, blob });
    if (attached === null) {
      // ⚠ **黙って消さない** ── 空き不足なら `attachOne` が理由を出しているが、
      //   出していない断り方(reducer が捨てた等)もあるので、ここでも 1 行言う
      deps.notify(`${why}${CAPTURE_LABEL[kind]}を取り込めませんでした`);
      return false;
    }
    putAssetIntoNote({
      dispatcher: deps.dispatcher,
      queue,
      notify: deps.notify,
      into,
      attachedLid: attached.lid,
      assetKey: attached.assetKey,
      name,
      mime,
      why,
      // 🔑 分かれた回だけ印を付ける(1 本なら「元に戻す」は元から 1 回である)
      ...(tag === null ? {} : { batch: tag }),
    });
    return true;
  };

  /**
   * 🔴 **編集が終わるまで預かる**(捨てない)。
   * ⚠ 見張りは**1 本だけ**張って、取り込んだら外す ── 張りっぱなしにすると
   *   以後の全 dispatch でここを通る(常駐を作らない)。
   */
  const hold = (
    blob: Blob,
    kind: CaptureKind,
    why: string,
    part: number | null,
    at: Date,
    tag: string | null,
  ): void => {
    queue.push(async () => {
      // 🔴 預かった 1 本も、入らなければ録るのをやめる(下の `stopNoRoom` と同じ理由)
      if (!(await ingest(blob, kind, why, part, at, tag)) && part !== null) stopNoRoom(kind);
    });
    deps.notify(`${why}${CAPTURE_LABEL[kind]}を預かりました(編集を終えると、開いているノートに入れます)`);
  };

  /**
   * 🔴 **1 本を届ける**(#771)。⚠ 途中で切れた本も、最後の 1 本も**ここを通る** ──
   *   通り道を分けると、片方だけ「編集中に預かる」を忘れる日が来る
   *   (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
   */
  const deliver = async (
    blob: Blob,
    kind: CaptureKind,
    why: string,
    part: number | null,
    at: Date,
    tag: string | null,
  ): Promise<'in' | 'held' | 'failed'> => {
    // 🔴 **編集中は添付が作れない** ── 捨てずに預かる
    if (deps.dispatcher.getState().phase !== 'ready') {
      hold(blob, kind, why, part, at, tag);
      return 'held';
    }
    return (await ingest(blob, kind, why, part, at, tag)) ? 'in' : 'failed';
  };

  /**
   * 🔴 **置き場に入らなかったら、録るのをやめる**(#771)。
   *
   * ⚠ 直す前(1 本しか作らなかった頃)は、**入らないと分かるのは終わった後**
   *   だけだった。分けて入れるようになった今は、**録っている最中に入らないことが
   *   分かる** ── そのまま録り続けると、250MB ごとに同じ断り文が出て、
   *   最後には**1 本も残らない**。
   * 🔑 だから止める。⚠ 止め方は `finish` を通さない ── 通すと最後の 1 本も
   *   取り込もうとして、**同じ理由でもう一度断られる**(その断り文が、
   *   こちらの説明を上書きしてしまう)。
   */
  const stopNoRoom = (kind: CaptureKind): void => {
    const h = handle;
    if (h === null || closing) return;
    // ⚠ **先に立てる** ── `h.stop()` が撃つ `onEnd` を `finish` に拾わせない
    closing = true;
    void h.stop().then(() => {
      close();
      deps.notify(
        `置き場に空きが無いので${CAPTURE_LABEL[kind]}を止めました(そこまでに入った分は残っています。空きを作ってから録り直してください)`,
      );
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
    /**
     * 🔴 **最後の 1 本が何本目か**(#771)。⚠ `stop()` の**前**に読む ──
     *   `parts()` は切るたびに増えるので、後から読むと本数がずれる。
     * 🔑 途中で 1 度も切っていなければ `null` = **連番を付けない**
     *   (分かれていない大多数の名前を変えないため)。
     */
    const before = h.parts();
    const at = startedAt ?? now();
    // 🔑 印は**分かれた回だけ** ── 1 本なら「元に戻す」は元から 1 回である
    const tag = before === 0 ? null : batch;
    const blob = await h.stop();
    close();
    if (blob === null || blob.size === 0) {
      /**
       * ⚠ **切れた本が既に落ちている回は「失敗」ではない**(#771)── 直す前は
       *   ここが「1 バイトも録れていません」しか言えなかったので、12 時間ぶんを
       *   3 本受け取った直後でも**失敗と読める**字が出るところだった。
       */
      if (before > 0) {
        deps.notify(`${why}${CAPTURE_LABEL[kind]}は ${before} 本に分けて入れました`);
        return;
      }
      // ⚠ ここは本当に**失敗**である(何も残っていない)── エラーの行へ出す
      fail(`${why}${CAPTURE_LABEL[kind]}できませんでした(1 バイトも録れていません)`);
      return;
    }
    await deliver(blob, kind, why, before === 0 ? null : before + 1, at, tag);
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
      const at = now();
      /**
       * 🔑 印は**始めるときに 1 つ**作る ── 切れた本ごとに作ると、
       *   「元に戻す」がまとまらない(#668 C の印は 1 回ぶんの取り込みを指す)。
       */
      const tag = `cap-${at.getTime()}`;
      try {
        handle = await start(kind, deps.capture ?? {}, {
          partBytes,
          maxMs,
          /**
           * 🔴 **切れた 1 本が落ちてくる**(#771)。⚠ 事情(`why`)は付けない ──
           *   まだ終わっていないので、言うことは「入れた」だけである。
           */
          onPart: (blob, part) => {
            void deliver(blob, kind, '', part, at, tag).then((r) => {
              // 🔴 入らなかったら録り続けない(次の 1 本も入らない)
              if (r === 'failed') stopNoRoom(kind);
            });
          },
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
      startedAt = at;
      batch = tag;
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
