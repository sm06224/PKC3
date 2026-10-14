/**
 * 編集中の字を、この端末に控える(#1376)。判断は `@features/draft/draft-recovery.ts`、
 * 置き場は `draft-store.ts`。ここは「いつ控え、いつ消すか」の配線だけを持つ。
 *
 * - 編集に入ったノートごとに 1 つの控え。打鍵が止まって 1 秒(打ち続けても 5 秒)で書く。
 * - 🔴 **保存(確定)で消すのは、disk に届いてから**(`openBody.persisted` が確定した本文になったとき)。
 *   確定した瞬間に消すと、書込が落ちた回に字がどこにも残らない。
 * - **取り消し**は消す。ただし**戻して入った回の取り消しは消さない**(「やめる」を押しただけで、
 *   戻した字を二度と戻せなくしない)。
 * - 🔴 **まだ答えていない控え(起動の 1 行)があるノートは、上書きしない**(`isPending`)。
 *   1 行を無視してそのノートを打つと、1 秒後に古い控えが新しい字で置き換わってしまう。
 * - 本文が編集に入ったときと同じに戻ったら(打って消した)控えも消す。
 * - ページを離れる・隠れるときは待っている分を書く(書き終わる保証はない ── 保険である)。
 *
 * ⚠ 題名は編集欄(`editor-title`)にだけ在り、確定まで state に写らない。そのため
 *   `input` を document で拾い、控えるときに欄の値を読む。
 */
import type { Dispatcher } from '../state/dispatcher';
import type { AppState } from '../state/app-state';
import {
  DraftThrottle,
  fingerprint,
  fitsDraft,
  type DraftClock,
  type DraftRecord,
} from '@features/draft/draft-recovery';
import type { DraftStore } from './draft-store';

export interface DraftWriterDeps {
  dispatcher: Dispatcher;
  store: DraftStore;
  cid: string;
  /** このタブの印(控えに書く)。 */
  tab: string;
  clock: DraftClock;
  /** 題名の編集欄の値(欄が無ければ `null`)。 */
  readTitle(): string | null;
  /** そのノートに、まだ答えていない控え(起動の 1 行)があるか。在れば上書きしない。 */
  isPending?(lid: string): boolean;
  /** 編集が終わった。`committed` = 保存で終えた(取り消しではない)。 */
  onEnded?(lid: string, committed: boolean): void;
  /**
   * 🔴 **書込の列が済んだ後の、disk のそのノートの本文**(#1087、複数タブの見直し)。
   * ⚠ 保存の確認(`persisted`)は**開いているノート**でしか届かない ── 確認の前に別のノートへ移ると、
   *   保存済みの控えが消えずに残り、次の起動で「保存していない編集」として出ていた。
   *   移った後はこれで disk を読み、保存した字と同じなら控えを消す。省略 = 従来どおり待つだけ。
   */
  readDiskBody?(lid: string): Promise<string | null>;
  /** `input` / `pagehide` を拾う先。省略 = `document` / `window`。 */
  doc?: Document;
  win?: Window;
}

/**
 * 🔴 **書込の列が済むのを待ってから disk を読む口**(`readDiskBody` の中身。#1087)。
 * ⚠ 待たずに読むと、まだ列に残っている保存より先に古い本文を読み、保存済みの控えを残してしまう。
 *   `main.ts` の配線は test から実行されないので、順番はここに置いて test する。
 */
export function readAfterSettle(
  settle: () => Promise<void>,
  read: (lid: string) => Promise<string | null>,
): (lid: string) => Promise<string | null> {
  return async (lid) => {
    await settle();
    return read(lid);
  };
}

export interface DraftWriter {
  /** 待っている書込が全部済むまで待つ(test 用)。 */
  settled(): Promise<void>;
  dispose(): void;
}

interface Session {
  readonly lid: string;
  /** 編集に入ったときの disk の本文の指紋。 */
  readonly base: string;
  /** 編集に入ったときの本文(取り消しで戻る先)。 */
  readonly startBody: string;
  /** 編集に入ったときの題名。 */
  readonly startTitle: string;
  /** 戻して入った回(入った瞬間に本文が基準と違う)。 */
  readonly restored: boolean;
  /** 最後に見た題名の欄の値。 */
  lastTitle: string;
}

export function connectDraftWriter(deps: DraftWriterDeps): DraftWriter {
  const { dispatcher, store, cid, tab } = deps;
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  let session: Session | null = null;
  let lastBody: string | null = null;
  /** 保存で終えて、disk に届くのを待っている控え(lid → 確定した本文)。 */
  const awaitingDisk = new Map<string, { body: string; adopted: boolean }>();
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>): void => {
    // 失敗は黙って諦める(控えは保険。編集を止めない)
    chain = chain.then(job).catch(() => {});
  };

  const write = (): void => {
    const st = dispatcher.getState();
    if (session === null || st.phase !== 'editing' || !st.openBody) return;
    if (st.openBody.lid !== session.lid) return;
    const lid = session.lid;
    // 🔴 答えていない控えが在るノートは触らない(古い控えを残す)
    if (deps.isPending?.(lid) === true) return;
    const body = st.openBody.body;
    const title = deps.readTitle() ?? session.lastTitle;
    session.lastTitle = title;
    const unchanged = body === st.openBody.baseline && title === session.startTitle;
    if (unchanged || !fitsDraft(body, title)) {
      // 打って消した / 大きすぎる ── 古い控えを残すと「戻す」で新しい字が失われて見える
      enqueue(() => store.remove(cid, lid, tab));
      return;
    }
    const rec: DraftRecord = {
      cid,
      lid,
      body,
      title,
      base: session.base,
      at: deps.clock.now(),
      tab,
    };
    enqueue(() => store.put(rec));
  };

  const throttle = new DraftThrottle(deps.clock, write);

  /** 編集が終わった。`st` は終わった後の state。 */
  const end = (st: AppState): void => {
    if (session === null) return;
    const s = session;
    session = null;
    throttle.cancel();
    const o = st.openBody;
    const bodyCommitted = lastBody !== null && lastBody !== s.startBody && o?.lid === s.lid && o.baseline === lastBody;
    const titleCommitted =
      s.lastTitle !== s.startTitle && st.entryMetas.get(s.lid)?.title === s.lastTitle;
    const committed = bodyCommitted || titleCommitted;
    if (committed) {
      // 🔴 disk に届くまで消さない(下の `settleAwaiting`)
      // 戻して入った回は、起動で聞いた別タブ(死んだタブ)の控えを引き取っている ── 誰の控えでも消す
      awaitingDisk.set(s.lid, { body: o?.lid === s.lid && bodyCommitted ? lastBody! : s.startBody, adopted: s.restored });
    } else if (!s.restored) {
      // 取り消し(または何も打たずに終えた)── 消す。戻して入った回は消さない
      enqueue(() => store.remove(cid, s.lid, tab));
    }
    deps.onEnded?.(s.lid, committed);
  };

  /**
   * disk を読みに行った lid(**1 つの保存につき 1 回だけ**読む)。⚠ 合わなかったときに消さないと、
   *   以後の状態の変化のたびに読み直しが飛ぶ(打つたびに worker を叩く)。次の編集で消す。
   * ⚠ 合わなかった控えは**残す**(保存が落ちた / 後から再送で通った回も、次の起動で聞かれるだけで、
   *   字は失われない ── 消す側へ倒さない)。
   */
  const checking = new Set<string>();

  /** 保存した本文が disk に届いたら控えを消す。 */
  const settleAwaiting = (st: AppState): void => {
    for (const [lid, { body, adopted }] of awaitingDisk) {
      if (st.openBody?.lid === lid && st.openBody.persisted === body) {
        awaitingDisk.delete(lid);
        enqueue(() => (adopted ? store.remove(cid, lid) : store.remove(cid, lid, tab)));
        continue;
      }
      // 🔴 そのノートを離れた後は、確認が画面に届かない ── disk を読んで確かめる(`readDiskBody`)
      if (st.openBody?.lid !== lid && deps.readDiskBody !== undefined && !checking.has(lid)) {
        checking.add(lid);
        void deps
          .readDiskBody(lid)
          .then((disk) => {
            const still = awaitingDisk.get(lid);
            // ⚠ 待っている間に同じノートの次の編集が始まったら触らない(控えは新しい編集のもの)
            if (disk === body && still !== undefined && still.body === body) {
              awaitingDisk.delete(lid);
              enqueue(() => (adopted ? store.remove(cid, lid) : store.remove(cid, lid, tab)));
            }
          })
          .catch(() => {
            /* 読めなければ控えを残す(消す側へ倒さない) */
          });
      }
    }
  };

  const onState = (st: AppState): void => {
    if (st.phase === 'editing' && st.openBody) {
      const o = st.openBody;
      if (session === null || session.lid !== o.lid) {
        end(st);
        const startTitle = st.entryMetas.get(o.lid)?.title ?? '';
        session = {
          lid: o.lid,
          base: fingerprint(o.baseline),
          startBody: o.baseline,
          startTitle,
          restored: o.body !== o.baseline,
          lastTitle: startTitle,
        };
        awaitingDisk.delete(o.lid); // 次の編集が始まった ── 控えは新しい編集のもの。前の保存の到着では消さない
        checking.delete(o.lid);
        lastBody = o.body;
        // 戻して入った回は、入った瞬間から控えを持つ(まだ打っていなくても落ちうる)
        if (o.body !== o.baseline) throttle.touch();
        return;
      }
      if (o.body !== lastBody) {
        lastBody = o.body;
        throttle.touch();
      }
      return;
    }
    // 確定・取り消し・別のノートへ ── 編集が終わった
    end(st);
    lastBody = null;
    settleAwaiting(st);
  };
  const off = dispatcher.onState(onState);

  const onInput = (ev: Event): void => {
    const t = ev.target as HTMLElement | null;
    if (session !== null && t?.getAttribute?.('data-pkc-field') === 'editor-title') {
      session.lastTitle = deps.readTitle() ?? session.lastTitle;
      throttle.touch();
    }
  };
  doc.addEventListener('input', onInput, true);
  const onHide = (): void => {
    if (doc.visibilityState === 'hidden') throttle.flush();
  };
  doc.addEventListener('visibilitychange', onHide);
  const onPageHide = (): void => throttle.flush();
  win.addEventListener('pagehide', onPageHide);

  // いま既に編集中なら(接続が遅れた)そのまま追う
  onState(dispatcher.getState());

  return {
    settled: async () => {
      await chain;
    },
    dispose: () => {
      off();
      throttle.cancel();
      doc.removeEventListener('input', onInput, true);
      doc.removeEventListener('visibilitychange', onHide);
      win.removeEventListener('pagehide', onPageHide);
    },
  };
}
