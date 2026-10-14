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
import {
  DRAFT_PART_NOUN,
  draftOfferLine,
  draftPartOfferLine,
  isLiveDraft,
  judgeDraft,
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
  /** 開いた欄へ打っていた字を入れる(欄が描かれてから呼ばれる)。 */
  setPartText(text: string): void;
  /** 戻せない欄の字を、クリップボードへ渡す(書けたら `true`)。 */
  copyText(text: string): Promise<boolean>;
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
  /** そのノートに、まだ答えていない控えがあるか(書き手が上書きしないために読む)。 */
  has(lid: string): boolean;
  /** いま、そのノートの控えを戻して編集している最中か(書き手が、やめたとき誰の控えでも消すために読む)。 */
  isRestoring(lid: string): boolean;
  /** 書き手から:編集が終わった。`committed` = 保存で終えた。 */
  editEnded(lid: string, committed: boolean): void;
}

/** 面の字。⚠ 押す字は画面の用語集に合わせる(`ui-terms.ts`)。 */
export const DRAFT_RESTORE_LABEL = '戻す';
export const DRAFT_DISCARD_LABEL = '消す';
/** 乗せたときの字 ── 「消す」がノートを消す操作に読まれないように。 */
export const DRAFT_RESTORE_TITLE = '保存していない編集を開き直します';
export const DRAFT_DISCARD_TITLE = '保存していない編集を消します(ノートは消えません)';
/** 戻した直後に 1 度だけ言う。 */
export const DRAFT_RESTORED_NOTE = '保存していない編集を戻しました。保存を押すまでノートは変わりません';
/** 編集に入れなかったとき。控えは残してある。 */
export const DRAFT_ENTER_FAILED_NOTE =
  `編集に入れませんでした。保存していない編集は残してあります。もう一度「${DRAFT_RESTORE_LABEL}」を押してください`;

/** 欄の控えを戻せなかったとき(#1728)。打った字は渡してあり、控えも残してある。 */
export function draftPartRefusedNote(kind: DraftPart['kind']): string {
  return `ノートの${DRAFT_PART_NOUN[kind]}が変わっているため、戻せません。打った字をコピーしました。保存していない編集は「${DRAFT_DISCARD_LABEL}」を押すまで残してあります`;
}
export function draftPartCopyFailedNote(kind: DraftPart['kind']): string {
  return `ノートの${DRAFT_PART_NOUN[kind]}が変わっているため、戻せません。打った字をコピーできませんでした。保存していない編集は残してあります。もう一度「${DRAFT_RESTORE_LABEL}」を押してください`;
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
  /** この起動のあいだ、もう聞かないノート(保存した / 取り消した)。 */
  const skip = new Set<string>();
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
      head.draft.part === undefined
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
      (r) => !skip.has(r.lid) && (r.tab === deps.tab || !isLiveDraft(r, deps.tab, live, deps.now())),
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
  const refusePart = (d: DraftRecord, part: DraftPart): void => {
    const failed = (): void => deps.say(draftPartCopyFailedNote(part.kind));
    deps.copyText(d.body).then((ok) => (ok ? deps.say(draftPartRefusedNote(part.kind)) : failed()), failed);
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
      if (d.part === undefined) deps.setTitle(d.title);
      else deps.setPartText(d.body);
      deps.say(DRAFT_RESTORED_NOTE);
    };
    const entered = (s: AppState): boolean =>
      d.part === undefined
        ? s.phase === 'editing' && s.openBody?.lid === d.lid
        : s.sectionDraft != null && s.sectionDraft.lid === d.lid;
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
      void store.remove(cid, head.draft.lid).catch(() => {});
      queue = queue.slice(1);
      paint();
    },
    text: () => shown,
    has: (lid) => queue.some((q) => q.draft.lid === lid && q.draft !== restoring),
    isRestoring: (lid) => restoring !== null && restoring.lid === lid,
    editEnded(lid, committed) {
      if (restoring !== null && restoring.lid === lid) {
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
      if (!queue.some((q) => q.draft.lid === lid)) skip.add(lid);
    },
  };
}
