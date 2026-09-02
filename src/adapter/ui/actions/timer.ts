/**
 * 🔴 **タイマーの段取り**(#279。user 指示 2026-08-19
 * 「…連絡先、**タイマー**、アラートは組み込みアプリでリリースしたい」)。
 *
 * 押す → 帯に出る → 止める → **開いていたノートの本文に作業時間の 1 行が入る**。
 *
 * ## 🔑 なぜ中央の面(アプリの一覧)に置かないか
 *
 * `features/launcher/tiles.ts` が #292 段⑤ で確立した見分け方:
 * **「それを閉じたとき user が失うものは何か」**。タイマーを閉じて計測が
 * 止まるのはおかしいし、⚠ **見るために本文を退かす**のはもっとおかしい
 * (#300 の user 指摘「メインの PKC の機能を阻害する方向でセンターペインを
 * 占有するな」)。だから **録音と同じ形** ── 左の列のボタン + 画面の下の帯。
 * ⚠ 帯を左の列の中に置かない ── 畳んだ瞬間に**止める口が消える**(#413 と同じ)。
 *
 * ## ここが持っている判断(`features/timer/timer-run.ts` は「字を作るだけ」)
 *
 * - **同じノートを 2 本同時に計らない**(二重に数えない ── 断って理由を出す)
 * - **追記できない種類は始める前に断る** ── 止めてから「書けません」では、
 *   計った時間の行き場が無い(⚠ 失うのは user の時間である)
 * - 🔴 **止めた瞬間に時計は止まる。書けないなら預かる**(`writable-queue.ts`)──
 *   「編集を終えてから押してください」と断ると、⚠ **断られている間も
 *   経過が伸びる**ので、記録が実際より長くなる
 * - **刻みは走っている間だけ張る**(0 本になったら外す ── 常駐を作らない。
 *   不可侵指示 2026-08-03)
 */
import type { Dispatcher } from '@adapter/state/dispatcher';
import { isAppendable } from '@features/flavor/append-spec';
import { workLogLine, workLogText, type TimerRun } from '@features/timer/timer-run';
import { createWritableQueue } from './writable-queue';

export interface TimerServiceDeps {
  readonly dispatcher: Dispatcher;
  /** 帯を描き直す合図。⚠ 空 = 何も計っていない(帯を畳む)。 */
  readonly onChange: (runs: readonly TimerRun[]) => void;
  /** 一時の知らせ(エラーの行とは別)。 */
  readonly notify: (text: string) => void;
  /** いまの時刻。⚠ `features/` と同じ約束で**外から渡す**(test は手で進める)。 */
  readonly now?: () => number;
  /** 1 秒ごとの合図。返り値は**外す関数**。⚠ test は手で撃つ。 */
  readonly tick?: (fn: () => void) => () => void;
}

export interface TimerService {
  /** いま開いているノートを計り始める。⚠ 断るときは**理由を出す**。 */
  start(): void;
  /** 止めて、本文へ作業時間の 1 行を入れる。 */
  stop(lid: string): void;
  /** 捨てる(本文は触らない)。 */
  discard(lid: string): void;
  /** 走っている計測(帯が読む)。 */
  runs(): readonly TimerRun[];
}

/** 既定の 1 秒刻み。⚠ 走っていない間は**張らない**(常駐を作らない)。 */
function intervalTick(fn: () => void): () => void {
  const id = setInterval(fn, 1000);
  return () => clearInterval(id);
}

export function createTimerService(deps: TimerServiceDeps): TimerService {
  const now = deps.now ?? ((): number => Date.now());
  const tick = deps.tick ?? intervalTick;
  const queue = createWritableQueue(deps.dispatcher);

  /** 走っている計測。⚠ **鍵は lid**(同じノートの 2 本目は断るので一意)。 */
  const running = new Map<string, TimerRun>();
  let untick: (() => void) | null = null;

  const fail = (error: string): void => deps.dispatcher.dispatch({ type: 'OP_FAILED', error });
  const paint = (): void => deps.onChange([...running.values()]);

  /**
   * 刻みを走っている本数に合わせる。
   * ⚠ **0 本になったら外す** ── 外さないと、1 度計っただけで以後ずっと
   *   1 秒ごとに描き直すことになる(不可侵指示「使われないなら解放する」)。
   */
  const armTick = (): void => {
    if (running.size > 0 && untick === null) untick = tick(paint);
    if (running.size === 0 && untick !== null) {
      untick();
      untick = null;
    }
  };

  const finish = (lid: string, run: TimerRun, endedAtMs: number): void => {
    const from = new Date(run.startedAtMs);
    const to = new Date(endedAtMs);
    const what = workLogText(from, to);
    /**
     * ⚠ **ノートが消えていたら、経過を字に出す** ── 黙って捨てると、
     *   user は「計っていた時間」を失ったことにすら気づかない。
     */
    if (!deps.dispatcher.getState().entryMetas.has(lid)) {
      deps.notify(`「${run.title}」が見つからないので本文に入れていません(${what})`);
      return;
    }
    const held = queue.push(() => {
      deps.dispatcher.dispatch({
        type: 'APPEND_TO_ENTRY',
        lid,
        text: workLogLine(from, to),
        heading: null,
        target: null,
      });
      deps.notify(`「${run.title}」に${what}を書きました`);
    });
    // ⚠ 預かった回は**そう言う**(押したのに何も起きていないように見せない)
    if (held) deps.notify(`「${run.title}」の${what}を預かりました(編集を終えると本文に入れます)`);
  };

  return {
    runs: () => [...running.values()],

    start() {
      const st = deps.dispatcher.getState();
      const lid = st.selectedLid;
      const meta = lid === null ? undefined : st.entryMetas.get(lid);
      /**
       * ⚠ **「ノートを開いていない」をここで数え直さない**(user 裁定 2026-09-02)。
       *   押した時点で `binder` の `NOTE_TOOL_ACTIONS` の門が断っている ──
       *   4 つの道具で断り方が食い違わないよう、判定は**そちら 1 か所**である
       *   (CLAUDE.md §7「同じ問いに答える口を 2 つ作らない」)。
       *   ここまで届くのは「選ばれているのに読めない」= データ側の異常だけ。
       */
      if (lid === null || meta === undefined) {
        fail('開いているノートが読めないので計れません');
        return;
      }
      /**
       * 🔴 **書けない種類は、始める前に断る**。⚠ 止めてから断ると、
       *   計った時間の行き場が無い(user が失うのは時間である)。
       */
      if (!isAppendable(meta.archetype)) {
        fail('開いているのは追記できない種類なので計れません(作業時間の行を入れられません)');
        return;
      }
      // ⚠ **2 本目を断る** ── 走らせると、止めた回数だけ行が増えて合計が倍になる
      if (running.has(lid)) {
        fail(`「${meta.title}」はもう計っています(先に止めてください)`);
        return;
      }
      running.set(lid, { lid, title: meta.title, startedAtMs: now() });
      armTick();
      paint();
      deps.notify(`「${meta.title}」を計り始めました`);
    },

    stop(lid) {
      const run = running.get(lid);
      if (run === undefined) return;
      /**
       * 🔴 **時計を先に止める**。⚠ 本文へ書けるかを待ってから止めると、
       *   待っている間も経過が伸びて**記録が実際より長くなる**。
       */
      const endedAtMs = now();
      running.delete(lid);
      armTick();
      paint();
      finish(lid, run, endedAtMs);
    },

    discard(lid) {
      const run = running.get(lid);
      if (run === undefined) return;
      running.delete(lid);
      armTick();
      paint();
      deps.notify(`「${run.title}」の計測を捨てました(本文には入れていません)`);
    },
  };
}
