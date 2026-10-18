/**
 * 起動したときの「保存していない編集が残っています」の 1 行(#1376)。
 *
 * 一式の判断は `@features/draft/draft-recovery.ts`。ここは面と、押されたときの動き。
 * 🔴 **画面に増える物はこの 1 行([戻す][消す])だけ** ── 設定も一覧も増やさない。
 *   モーダルにしない(起動した直後に操作を奪わない)。
 * 🔴 **戻す = 開いて編集に入るだけ。書かない。** 保存を押すまで disk は動かない
 *   (保存の衝突は、いつもの保存の経路がそのまま受ける)。
 * 🔴 **控えは、編集に入れたあとも消さない。** 消すのは「消す」を押したときと、書き手(`draft-writer.ts`)が
 *   保存の到着を見たときだけ。入れなかった回(ロックが取れない・本文が届かない・書込中)は何も失わず、
 *   1 行を戻して理由を言う。戻した編集を「やめる」で終えた回も、1 行がまた出る(戻した字を二度と戻せなくしない)。
 * ⚠ 編集中は 1 行を隠す(押しても断られるだけ)。編集が終わったらまた出す。
 * ⚠ 複数あるときは**新しい順に 1 件ずつ**聞く(「ほか N 件」を添える)。
 */
import type { Dispatcher } from '../../state/dispatcher';
import { SECTION_DRAFT_NOTE, phaseBlockReason, type AppState } from '../../state/app-state';
import { partOf } from '../../platform/draft-writer';
import {
  DRAFT_PART_NOUN,
  draftAppendOfferLine,
  draftOfferLine,
  draftPartOfferLine,
  isLiveDraft,
  judgeAppendDraft,
  judgeDraft,
  sameDraftPart,
  type DraftPart,
  type DraftRecord,
} from '@features/draft/draft-recovery';
import { judgePartDraft, locateDraftPart } from '@features/draft/draft-part';
import type { DraftStore } from '../../platform/draft-store';

export interface DraftOfferDeps {
  region: HTMLElement;
  dispatcher: Dispatcher;
  store: DraftStore;
  cid: string;
  tab: string;
  now(): number;
  /** 生きているタブ(取れない端末は `null`)。 */
  liveTabs(): Promise<ReadonlySet<string> | null>;
  /** 保存されている本文(無ければ `null`)。 */
  readBody(lid: string): Promise<string | null>;
  /**
   * 本文を差し替えて編集に入る ── 入り口は `startEditAt` の 1 本(ロック・書込待ちを通る。
   * `binder.ts` の `startEditRestoring`)。⚠ 同期に入るとは限らない。
   */
  enterEdit(body: string): void;
  /** 題名の編集欄へ戻す(編集に入って欄が描かれてから呼ばれる)。 */
  setTitle(title: string): void;
  /**
   * 章の欄 / コード枠の欄を開く(#1728)。`line` は本文の行(frontmatter を剥がした側)── 入り口は
   * `binder.ts` の `startPartialRestoring` の 1 本(ロック・書込待ちを通る)。⚠ 同期に開くとは限らない。
   */
  enterPart(kind: DraftPart['kind'], line: number): void;
  /**
   * 開いた欄へ打っていた字を入れる(欄が描かれてから呼ばれる)。入れられたら `true`。
   * ⚠ 欄が出なかった(`false`)ときは「戻しました」と言わない ── 控えを残して理由を言う。
   */
  setPartText(text: string): Promise<boolean>;
  /** 戻せない欄の字を、クリップボードへ渡す(書けたら `true`)。 */
  copyText(text: string): Promise<boolean>;
  /**
   * 開いたノートの追記欄へ、打っていた字を入れる(依頼 330。欄が描かれてから呼ばれる)。入れられたら `true`。
   * ⚠ 欄が出なかった(`false`)ときは「戻しました」と言わない ── 控えを残して理由を言う。
   */
  setAppendText?(lid: string, text: string): Promise<boolean>;
  say(message: string): void;
  /** 編集に入れるまで待つ長さ(ms)。省略 = 10 秒。 */
  waitMs?: number;
}

interface Queued {
  readonly draft: DraftRecord;
  readonly moved: boolean;
}

export interface DraftOffer {
  /** 起動のとき 1 度。出すものが無ければ何も出さない。 */
  present(): Promise<void>;
  restore(): void;
  discard(): void;
  /** いま出している 1 行の字(出していなければ `null`)。 */
  text(): string | null;
  /** そのノートに、まだ答えていない控えがあるか(書き手が上書きしないために読む)。`append` = 追記欄の控え。 */
  has(lid: string, append?: boolean): boolean;
  /** いま、そのノートの控えを戻して編集している最中か(書き手が、やめたとき誰の控えでも消すために読む)。 */
  isRestoring(lid: string): boolean;
  /** 書き手から:編集が終わった。`committed` = 保存で終えた。 */
  editEnded(lid: string, committed: boolean): void;
  /**
   * 🔴 **別のウィンドウ(付箋など)が閉じた**(依頼 219・329)。そのウィンドウが書きかけのまま閉じたなら、
   * 起動を待たずにその場で 1 行を出す。書きかけが残っていて聞くものになったら `true`。
   * ⚠ 起動のとき 1 度しか聞かない形だと、本体を開いたままの人は次に起動し直すまで書きかけに気づけなかった。
   */
  leftBehind(tab: string): Promise<boolean>;
}

/** 面の字。⚠ 押す字は画面の用語集に合わせる(`ui-terms.ts`)。 */
export const DRAFT_RESTORE_LABEL = '戻す';
export const DRAFT_DISCARD_LABEL = '消す';
/** 乗せたときの字 ── 「消す」がノートを消す操作に読まれないように。 */
export const DRAFT_RESTORE_TITLE = '保存していない編集を開き直します';
export const DRAFT_DISCARD_TITLE = '保存していない編集を消します(ノートは消えません)';
/** 追記欄へ戻した直後に 1 度だけ言う(依頼 330)。 */
export const DRAFT_APPEND_RESTORED_NOTE = '追記欄に戻しました。「本文に追記する」を押すまでノートは変わりません';
/** 戻した直後に 1 度だけ言う。 */
export const DRAFT_RESTORED_NOTE = '保存していない編集を戻しました。保存を押すまでノートは変わりません';
/** 編集に入れなかったとき。控えは残してある。 */
export const DRAFT_ENTER_FAILED_NOTE =
  `編集に入れませんでした。保存していない編集は残してあります。もう一度「${DRAFT_RESTORE_LABEL}」を押してください`;

/** 欄の控えを戻せなかったとき(#1728)。打った字は渡してあり、控えも残してある。 */
export function draftPartRefusedNote(kind: DraftPart['kind'], why: 'changed' | 'other' = 'changed'): string {
  const lead = why === 'changed' ? `ノートの${DRAFT_PART_NOUN[kind]}が変わっている` : `別の${DRAFT_PART_NOUN[kind]}の編集を始めた`;
  return `${lead}ため、戻せません。打った字をコピーしました。保存していない編集は「${DRAFT_DISCARD_LABEL}」を押すまで残してあります`;
}
export function draftPartCopyFailedNote(kind: DraftPart['kind'], why: 'changed' | 'other' = 'changed'): string {
  const lead = why === 'changed' ? `ノートの${DRAFT_PART_NOUN[kind]}が変わっている` : `別の${DRAFT_PART_NOUN[kind]}の編集を始めた`;
  return `${lead}ため、戻せません。打った字をコピーできませんでした。保存していない編集は残してあります。もう一度「${DRAFT_RESTORE_LABEL}」を押してください`;
}

/**
 * いま戻せない理由。⚠ 出口の字は画面に在るボタンの字から引く(`refusal-words.test.ts` が
 * 「確定」「取り消し」を src から締め出している)── 編集中は `phaseBlockReason` の 1 本に揃える。
 */
export function draftBusyNote(s: AppState): string {
  return s.phase !== 'ready'
    ? `${phaseBlockReason(s.phase)}「${DRAFT_RESTORE_LABEL}」を押してください`
    : SECTION_DRAFT_NOTE;
}

export function createDraftOffer(deps: DraftOfferDeps): DraftOffer {
  const { region, dispatcher, store, cid } = deps;
  let queue: Queued[] = [];
  let shown: string | null = null;
  /** いま戻している最中(または戻して編集中)の控え。 */
  let restoring: DraftRecord | null = null;
  /** この起動のあいだ、もう聞かないノート(保存した / 取り消した)。⚠ 追記欄の控えは別の鍵(`skipKey`)。 */
  const skip = new Set<string>();
  const skipKey = (r: Pick<DraftRecord, 'lid' | 'append'>): string => (r.append === true ? `${r.lid}\u0000append` : r.lid);
  let loadSeq = 0;

  const busy = (s: AppState): boolean => s.phase === 'editing' || s.sectionDraft != null;

  const paint = (): void => {
    region.textContent = '';
    const head = queue[0];
    // 戻している間・編集中は出さない(押しても断られるだけ)
    if (head === undefined || restoring !== null || busy(dispatcher.getState())) {
      region.hidden = true;
      shown = null;
      return;
    }
    const title = dispatcher.getState().entryMetas.get(head.draft.lid)?.title ?? head.draft.title;
    shown =
      head.draft.append === true
        ? draftAppendOfferLine(title, queue.length - 1)
        : head.draft.part === undefined
          ? draftOfferLine(title, head.moved, queue.length - 1)
          : draftPartOfferLine(title, head.draft.part.kind, head.moved, queue.length - 1);
    const text = document.createElement('span');
    text.setAttribute('data-pkc-field', 'draft-offer-text');
    text.textContent = shown;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.setAttribute('data-pkc-action', 'restore-draft');
    restore.title = DRAFT_RESTORE_TITLE;
    restore.textContent = DRAFT_RESTORE_LABEL;
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.setAttribute('data-pkc-action', 'discard-draft');
    discard.title = DRAFT_DISCARD_TITLE;
    discard.textContent = DRAFT_DISCARD_LABEL;
    region.append(text, restore, discard);
    region.hidden = false;
  };

  /** 控えを読み直して、聞くものを組み直す(起動のとき・編集が終わったとき)。 */
  const load = async (): Promise<void> => {
    const seq = ++loadSeq;
    let rows: DraftRecord[];
    try {
      rows = await store.list(cid);
    } catch {
      return;
    }
    if (rows.length === 0) {
      if (seq === loadSeq) {
        queue = [];
        paint();
      }
      return;
    }
    const live = await deps.liveTabs();
    // 自分のタブの控えは、戻して「やめた」回の物だけが残る(通常の編集は終わりに消える)
    const mine = rows.filter(
      (r) =>
        !skip.has(skipKey(r)) &&
        // 🔴 追記欄の控えは、生きているタブの物を聞かない ── 自分のタブの物も「生きている」(`isLiveDraft`)ので、
        //    打っている最中の字が、編集の終わりのたびに 1 行に出てしまうことはない
        (r.append === true
          ? !isLiveDraft(r, deps.tab, live, deps.now())
          : r.tab === deps.tab || !isLiveDraft(r, deps.tab, live, deps.now())),
    );
    const out: Queued[] = [];
    for (const d of mine.sort((a, b) => b.at - a.at)) {
      let body: string | null;
      try {
        body = await deps.readBody(d.lid);
      } catch {
        continue; // 読めなかった ── 控えは残す(次の起動で聞く)
      }
      const meta = dispatcher.getState().entryMetas.get(d.lid);
      if (d.append === true) {
        // 追記欄の控え(依頼 330)── ノートが無い / もう本文に入っている / 空 は黙って片付ける
        const av = judgeAppendDraft(d, meta === undefined ? null : body);
        if (av !== 'plain') {
          await store.remove(cid, d.lid, undefined, true).catch(() => {});
          continue;
        }
        out.push({ draft: d, moved: false });
        continue;
      }
      if (d.part !== undefined) {
        // 欄の控え(#1728)── 欄が見つかり原文のままなら戻せる / 変わっていれば戻さない(字はコピーで渡す)
        const pv = judgePartDraft({ ...d, part: d.part }, meta === undefined ? null : body);
        if (pv === 'gone' || pv === 'same') {
          await store.remove(cid, d.lid).catch(() => {});
          continue;
        }
        out.push({ draft: d, moved: pv === 'moved' });
        continue;
      }
      const v = judgeDraft(d, body === null || meta === undefined ? null : { body, title: meta.title });
      if (v === 'gone' || v === 'same') {
        // 聞くことが無い控えは黙って片付ける
        await store.remove(cid, d.lid).catch(() => {});
        continue;
      }
      out.push({ draft: d, moved: v === 'moved' });
    }
    if (seq !== loadSeq) return; // 後から始まった読み直しが勝つ
    queue = out;
    paint();
  };

  /** 戻せない欄の字をコピーで渡す(#1728)。控えは消さない。 */
  const refusePart = (d: DraftRecord, part: DraftPart, why: 'changed' | 'other' = 'changed'): void => {
    const failed = (): void => deps.say(draftPartCopyFailedNote(part.kind, why));
    deps.copyText(d.body).then((ok) => (ok ? deps.say(draftPartRefusedNote(part.kind, why)) : failed()), failed);
  };

  /**
   * 追記欄の控えを戻す(依頼 330)。ノートを選び、本文が届いて欄が出たら字を入れる。**書かない** ──
   * 「本文に追記する」を押すまで disk は動かない。控えは、入れたあと書き手(`draft-writer.ts`)が自分の控えとして書き直す。
   */
  const openForAppend = (d: DraftRecord): void => {
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const stop = (): void => {
      unsub?.();
      unsub = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const fail = (): void => {
      if (done) return;
      done = true;
      stop();
      restoring = null;
      paint();
      deps.say(DRAFT_ENTER_FAILED_NOTE);
    };
    const put = (): void => {
      if (done || deps.setAppendText === undefined) return fail();
      done = true;
      stop();
      void deps.setAppendText(d.lid, d.body).then(
        (ok) => {
          if (!ok) {
            restoring = null;
            paint();
            deps.say(DRAFT_ENTER_FAILED_NOTE);
            return;
          }
          // 入れた ── 1 行は片付ける(控えは書き手が自分の物として書き直す)
          queue = queue.filter((q) => q.draft !== d);
          skip.add(skipKey(d));
          restoring = null;
          paint();
          deps.say(DRAFT_APPEND_RESTORED_NOTE);
        },
        fail,
      );
    };
    const ready = (s: AppState): boolean =>
      s.selectedLid === d.lid && s.openBody?.lid === d.lid && s.phase === 'ready' && s.sectionDraft == null;
    timer = setTimeout(fail, deps.waitMs ?? 10_000);
    unsub = dispatcher.onState((s) => {
      if (done) return;
      if (ready(s)) put();
      else if (s.phase !== 'ready' || s.selectedLid !== d.lid) fail();
    });
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: d.lid });
    if (!done && ready(dispatcher.getState())) put();
  };

  /** 開いて編集に入る ── 本文が届くのを待ってから入る(届く前の `START_EDIT` は弾かれる)。 */
  const openForEdit = (d: DraftRecord): void => {
    const subs: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const stopAll = (): void => {
      for (const off of subs.splice(0)) off();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const fail = (): void => {
      if (done) return;
      done = true;
      stopAll();
      // 🔴 控えは消さない。1 行を戻して理由を言う
      restoring = null;
      paint();
      deps.say(DRAFT_ENTER_FAILED_NOTE);
    };
    const succeed = (): void => {
      if (done) return;
      done = true;
      stopAll();
      if (d.part === undefined) {
        deps.setTitle(d.title);
        deps.say(DRAFT_RESTORED_NOTE);
        return;
      }
      void deps.setPartText(d.body).then(
        (ok) => {
          if (ok) {
            deps.say(DRAFT_RESTORED_NOTE);
            return;
          }
          // 欄が出なかった ── 「戻しました」と言わない。控えは残す
          restoring = null;
          paint();
          deps.say(DRAFT_ENTER_FAILED_NOTE);
        },
        () => {
          restoring = null;
          paint();
          deps.say(DRAFT_ENTER_FAILED_NOTE);
        },
      );
    };
    /**
     * 🔴 入れたか。欄の控えは**この控えの欄**(同じ見出し / 同じ枠 + 開いたときの原文)が開いたときだけ ──
     * 開く口は非同期(ロック・書込待ち)なので、待つ間に同じノートの別の欄が開くと、字が別の欄へ入る。
     */
    const entered = (s: AppState): boolean => {
      if (d.part === undefined) return s.phase === 'editing' && s.openBody?.lid === d.lid;
      const sd = s.sectionDraft;
      if (sd == null || sd.lid !== d.lid) return false;
      const now = partOf(sd);
      return sameDraftPart(now, d.part) && now.original === d.part.original;
    };
    let entering = false;
    const tryEnter = (s: AppState): boolean => {
      if (entering) return true;
      if (s.selectedLid !== d.lid || s.openBody?.lid !== d.lid || s.phase !== 'ready') return false;
      entering = true;
      if (d.part === undefined) {
        deps.enterEdit(d.body);
      } else {
        // 🔴 待つ間に本文が変わっているかもしれない ── 開く直前に、いまの本文で探し直す
        const loc = locateDraftPart(s.openBody.body, d.part);
        if (!loc.ok) {
          done = true;
          stopAll();
          restoring = null;
          paint();
          refusePart(d, d.part);
          return true;
        }
        deps.enterPart(d.part.kind, loc.line);
      }
      if (entered(dispatcher.getState())) succeed();
      return true;
    };
    // ⚠ 待ち全体を 1 本の時計で覆う(本文が届かない / ロックが取れない / 書込中で入れない)
    timer = setTimeout(fail, deps.waitMs ?? 10_000);
    subs.push(
      dispatcher.onState((s) => {
        if (done) return;
        if (entered(s)) {
          succeed();
          return;
        }
        if (d.part !== undefined && s.sectionDraft != null && s.sectionDraft.lid === d.lid) {
          // 別の欄が開いた ── 字は入れず、打った字をコピーで渡す
          done = true;
          stopAll();
          restoring = null;
          paint();
          refusePart(d, d.part, 'other');
          return;
        }
        if (tryEnter(s)) return;
        // 別のノートへ移った / 別の編集が始まった ── 待たない
        if (s.phase !== 'ready' || s.selectedLid !== d.lid) fail();
      }),
    );
    dispatcher.dispatch({ type: 'SELECT_ENTRY', lid: d.lid });
    if (!done) tryEnter(dispatcher.getState());
  };

  // 編集が終わったら聞き直す(隠していた 1 行を出す)。購読はアプリの寿命と同じ
  let wasBusy = busy(dispatcher.getState());
  dispatcher.onState((s) => {
    const now = busy(s);
    const ended = wasBusy && !now;
    wasBusy = now;
    paint();
    if (ended) void load();
  });

  return {
    present: load,
    restore() {
      const head = queue[0];
      if (head === undefined || restoring !== null) return;
      const s = dispatcher.getState();
      if (s.phase !== 'ready' || s.sectionDraft != null) {
        deps.say(draftBusyNote(s));
        return;
      }
      if (head.draft.append === true) {
        // 追記欄の控え(依頼 330)── 編集は始めず、欄へ字を戻すだけ
        restoring = head.draft;
        paint();
        openForAppend(head.draft);
        return;
      }
      if (head.draft.part !== undefined && head.moved) {
        // 🔴 欄が変わっている ── 書かない。打った字をコピーで渡し、控えは残す(1 行もそのまま)
        refusePart(head.draft, head.draft.part);
        return;
      }
      restoring = head.draft;
      paint();
      openForEdit(head.draft);
    },
    discard() {
      const head = queue[0];
      if (head === undefined || restoring !== null) return;
      void store.remove(cid, head.draft.lid, undefined, head.draft.append === true).catch(() => {});
      queue = queue.slice(1);
      paint();
    },
    text: () => shown,
    has: (lid, append = false) =>
      queue.some((q) => q.draft.lid === lid && (q.draft.append === true) === append && q.draft !== restoring),
    // 追記欄の控えを戻している間は「戻して編集中」ではない(全文編集の控えの取り扱いと取り違えない)
    isRestoring: (lid) => restoring !== null && restoring.lid === lid && restoring.append !== true,
    async leftBehind(tab) {
      let rows: DraftRecord[];
      try {
        rows = (await store.list(cid)).filter((r) => r.tab === tab);
      } catch {
        return false;
      }
      if (rows.length === 0) return false;
      // この起動のあいだ「もう聞かない」に入れたノートでも、別のウィンドウが新しく残した控えは聞く
      for (const r of rows) skip.delete(skipKey(r));
      await load();
      return queue.some((q) => q.draft.tab === tab);
    },
    editEnded(lid, committed) {
      if (restoring !== null && restoring.lid === lid && restoring.append !== true) {
        const r = restoring;
        restoring = null;
        if (r.part !== undefined) {
          // 欄の控え(#1728):保存でもやめても書き手が控えを消す(別の場所の操作で閉じられたときだけ残る ──
          // それは次の起動で聞く)。取り消しの 1 行を戻さない
          queue = queue.filter((q) => q.draft !== r);
          skip.add(lid);
          return;
        }
        if (committed) {
          // 保存した ── 書き手が disk への到着を見て控えを消す。聞き直しにも出さない
          queue = queue.filter((q) => q.draft !== r);
          skip.add(lid);
        }
        // 取り消した ── 控えは書き手が消していない。1 行が戻る(`load` が読み直す)
        return;
      }
      // 答えていない控えが在るノートは、編集が終わっても聞き直す(読み直して判定し直す)。無ければ聞かない
      if (!queue.some((q) => q.draft.lid === lid && q.draft.append !== true)) skip.add(lid);
    },
  };
}
