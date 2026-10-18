/**
 * 保存していない編集の復元(#1376)── 判断だけを持つ純関数。
 *
 * 何が起きていたか:編集中の字は画面(AppState)にしか無く、タブが落ちる・
 * ブラウザが再起動する・電源が切れると、保存していない分は戻らない。
 * 🔑 だから編集中の字を**この端末にだけ**控え、次に開いたとき「戻す / 消す」を 1 行で聞く。
 *
 * 🔴 **控えは container に入れない** ── 書き出し・バックアップ・履歴・メッセージに
 * 同乗させない(`copy-history-store.ts` / `notice-store.ts` と同じ判断。確定していない
 * 字を端末の外へ出さない)。置き場は `platform/draft-store.ts`(IndexedDB)。
 *
 * ## 上限(超えたときに起きること)
 * - 1 件 {@link DRAFT_BYTES_MAX}(2 MB)を超える本文は**控えない**(編集はそのまま続く。
 *   そのノートだけ、タブが落ちたときの復元が効かない)。既に在る控えは消す
 *   (古い版を「戻す」と、新しい字が失われたように見えるため)。
 * - 全体で {@link DRAFT_COUNT_MAX}(20)件 ── 超えたら**古い控えから**消える。
 *
 * ## 複数のタブ
 * 控えの鍵は「コレクション × ノート」。2 枚のタブが同じノートを編集したら**後に書いた
 * ほうが残る**(`at` の新しいほう)。消すのは**自分が書いた控えだけ**(`tab` が自分のとき)
 * ── 別タブの編集中の控えを、こちらの保存で消さない。
 */

/** 1 件の上限(UTF-8 の byte)。 */
export const DRAFT_BYTES_MAX = 2 * 1024 * 1024;
/** 端末に残す控えの件数の上限。 */
export const DRAFT_COUNT_MAX = 20;
/** 打鍵が止まってから控えるまで。 */
export const DRAFT_QUIET_MS = 1000;
/** 打ち続けていても、この間隔では必ず控える。 */
export const DRAFT_MAX_WAIT_MS = 5000;
/**
 * 生きているタブの印が使えない端末で、「まだ別のタブが編集中かもしれない」と見なす間。
 * ⚠ 控えは打鍵のたびに(最長 {@link DRAFT_MAX_WAIT_MS} ごとに)更新されるので、これより古ければ止まっている。
 */
export const DRAFT_LIVE_FALLBACK_MS = 30_000;

/**
 * 章の欄 / コード枠の欄に打っていた字の控え(#1728)── どの欄を開き直すかの身元。
 * ⚠ 身元は `SectionDraft` / `CodeDraft`(`app-state.ts`)が開いたときに持つ物と同じ(保存のとき探し直す物)。
 *   `original` = 開いたときのその章 / 枠の原文。戻すとき、いまの本文のその場所と比べる。
 */
export type DraftPart =
  | { readonly kind: 'section'; readonly heading: string; readonly original: string }
  | {
      readonly kind: 'code';
      readonly line: number;
      readonly openLine: string;
      readonly quote: number;
      readonly original: string;
    };

/** 身元が同じ欄か。 */
export function sameDraftPart(a: DraftPart, b: DraftPart): boolean {
  if (a.kind === 'section' && b.kind === 'section') return a.heading === b.heading;
  if (a.kind === 'code' && b.kind === 'code') {
    return a.line === b.line && a.openLine === b.openLine && a.quote === b.quote;
  }
  return false;
}

/** 置き場から読んだ値が {@link DraftPart} の形か。 */
export function isDraftPart(v: unknown): v is DraftPart {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.original !== 'string') return false;
  if (r.kind === 'section') return typeof r.heading === 'string';
  if (r.kind === 'code') {
    return typeof r.line === 'number' && typeof r.openLine === 'string' && typeof r.quote === 'number';
  }
  return false;
}

/** 端末に置く 1 件。 */
export interface DraftRecord {
  /** コレクション(`cid`)。 */
  readonly cid: string;
  readonly lid: string;
  /** 編集中の本文(原文)。 */
  readonly body: string;
  /** 編集中の題名。 */
  readonly title: string;
  /** 編集に入ったときの本文の指紋({@link fingerprint})。保存されている本文と比べる。 */
  readonly base: string;
  /** 控えた時刻(ms)。 */
  readonly at: number;
  /** 書いたタブ。 */
  readonly tab: string;
  /**
   * 🔴 章の欄 / コード枠の欄に打っていた字の控えのとき(#1728)。このとき `body` = **打っていた欄の字**
   * (ノート全文ではない)、`title` = 空、`base` = 開いたときの欄の原文の指紋。無ければ全文編集の控え。
   */
  readonly part?: DraftPart;
  /**
   * 🔴 ノートの下の**追記欄**に打っていた字の控えのとき(依頼 330)。このとき `body` = 打っていた字、`title` = 空、
   * `base` = 空。全文編集・章の編集の控えとは**別の鍵**で持つ(同じ鍵だと、章の編集の控えと取り合って消し合う)。
   */
  readonly append?: true;
}

/**
 * 鍵。⚠ 置き場の鍵と、消すときの鍵はこの 1 本。
 * 🔴 追記欄の控えは**別の鍵**(依頼 330)── ノートごとに全文編集の控えと追記欄の控えを 1 件ずつ持てる。
 */
export function draftKey(cid: string, lid: string, append = false): string {
  return append ? `${cid}\u0000${lid}\u0000append` : `${cid}\u0000${lid}`;
}

/** 控え 1 件の鍵(`append` を見て選ぶ。⚠ 置き場 2 つと書き手が同じ 1 本を通る)。 */
export function draftKeyOf(r: Pick<DraftRecord, 'cid' | 'lid' | 'append'>): string {
  return draftKey(r.cid, r.lid, r.append === true);
}

/**
 * 本文の指紋(FNV-1a 32bit + 長さ)。⚠ 同じ本文かを見るだけで、秘密を守る用途ではない。
 * 同期で出したいので crypto は使わない。
 */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${String(text.length)}`;
}

/** 本文の byte 数(UTF-8)。 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 控えてよい大きさか。 */
export function fitsDraft(body: string, title: string): boolean {
  return byteLength(body) + byteLength(title) <= DRAFT_BYTES_MAX;
}

/** 上限を超えた分を古い順に削った残り(新しい順)。 */
export function pruneDrafts(list: readonly DraftRecord[]): DraftRecord[] {
  return [...list].sort((a, b) => b.at - a.at).slice(0, DRAFT_COUNT_MAX);
}

/**
 * 起動時、保存されているノートと控えを比べた結果。
 * - `gone`   ノートが無い(消された)── 控えは黙って片付ける
 * - `same`   控えと保存されている本文**と題名**が同じ ── 聞くことが無い(片付ける)
 * - `plain`  普通に戻せる
 * - `moved`  編集に入ったあとで、保存されている本文が変わっている(別の場所で更新)
 */
export type DraftVerdict = 'gone' | 'same' | 'plain' | 'moved';

export function judgeDraft(
  draft: DraftRecord,
  stored: { readonly body: string; readonly title: string } | null,
): DraftVerdict {
  if (stored === null) return 'gone';
  // 🔴 題名だけ直した控えを「同じ」と読まない(本文だけ比べると、題名の編集が黙って片付く)
  if (stored.body === draft.body && stored.title === draft.title) return 'same';
  return fingerprint(stored.body) === draft.base ? 'plain' : 'moved';
}

/**
 * 「別の場所で更新されています」に添える、戻して保存したときに起きること。
 * ⚠ 事実で書く:保存のとき、そのときの disk の本文は履歴に積まれる(`COMMIT_EDIT` の checkpoint。
 *   `tests/adapter/draft-recovery.test.ts` が、戻した控えを新しい disk の上へ保存して checkpoint が立つことを見る)。
 */
export const MOVED_TAIL = '。別の場所で更新されています。戻して保存すると、その更新は履歴に残ります';

/**
 * 追記欄の控えを戻す価値があるか(依頼 330)。
 * - `gone`  ノートが無い ── 黙って片付ける
 * - `same`  字が空 / もう本文に入っている(送った後に控えが残った)── 聞くことが無い(片付ける)
 * - `plain` 戻せる
 * ⚠ 「本文に入っている」は**字がそのまま含まれるか**で見る(追記は字を足すだけで、書き換えない)。
 */
export function judgeAppendDraft(draft: DraftRecord, storedBody: string | null): 'gone' | 'same' | 'plain' {
  if (storedBody === null) return 'gone';
  const text = draft.body.trim();
  if (text === '' || storedBody.includes(text)) return 'same';
  return 'plain';
}

/** 起動時の 1 行(追記欄の控え)。題名は空のとき「無題」。 */
export function draftAppendOfferLine(title: string, rest: number): string {
  const name = title.trim() === '' ? '無題' : title;
  const more = rest > 0 ? `。ほか ${String(rest)} 件` : '';
  return `保存していない追記が残っています(${name})${more}`;
}

/**
 * 別のウィンドウ(付箋など)が書きかけのまま閉じたとき、本体の「システム」のメッセージに足す 1 件(依頼 219・329)。
 * 🔴 **ノートの題名は書かない** ── メッセージは中身を漏らさない決まり(題名は `sanitizeMessageText` が伏せる)。
 *   ⚠ **「」で囲んだボタン名も書かない** ── 伏せ字処理は「」の中を全部伏せる(ボタン名が「…」になる)。
 *   どのノートかは、画面の 1 行(`draftOfferLine`)が言う。
 */
export const DRAFT_LEFT_MESSAGE =
  '別のウィンドウで書いていた編集が、保存されないまま残っています。画面に出る戻すボタンから開き直せます';

/** 起動時の 1 行(題名は空のとき「無題」)。 */
export function draftOfferLine(title: string, moved: boolean, rest: number): string {
  const name = title.trim() === '' ? '無題' : title;
  const base = `保存していない編集が残っています(${name})`;
  const tail = moved ? MOVED_TAIL : '';
  const more = rest > 0 ? `。ほか ${String(rest)} 件` : '';
  return `${base}${tail}${more}`;
}

/** 欄の名前(画面の字。章 / コード)。 */
export const DRAFT_PART_NOUN = { section: '章', code: 'コード' } as const;

/** 欄の控えが戻せないときに添える。「戻す」を押すと何が起きるかを先に言う。 */
export function partMovedTail(kind: DraftPart['kind']): string {
  return `。ノートの${DRAFT_PART_NOUN[kind]}が変わっているため、そのままは戻せません。「戻す」を押すと打った字をコピーします`;
}

/** 起動時の 1 行(欄の控え)。題名は空のとき「無題」。 */
export function draftPartOfferLine(title: string, kind: DraftPart['kind'], moved: boolean, rest: number): string {
  const name = title.trim() === '' ? '無題' : title;
  const base = `保存していない${DRAFT_PART_NOUN[kind]}の編集が残っています(${name})`;
  const tail = moved ? partMovedTail(kind) : '';
  const more = rest > 0 ? `。ほか ${String(rest)} 件` : '';
  return `${base}${tail}${more}`;
}

/**
 * 生きているタブの控えか。
 * @param live 生きているタブの id(取れない端末では `null`)
 */
export function isLiveDraft(
  draft: DraftRecord,
  own: string,
  live: ReadonlySet<string> | null,
  now: number,
): boolean {
  if (draft.tab === own) return true;
  if (live !== null) return live.has(draft.tab);
  return now - draft.at < DRAFT_LIVE_FALLBACK_MS;
}

/** タイマーの口。test は偽物を渡す。 */
export interface DraftClock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/**
 * 控える頻度を決める(打鍵が {@link DRAFT_QUIET_MS} 止まったら控える。
 * 打ち続けていても {@link DRAFT_MAX_WAIT_MS} を超えて待たせない)。
 */
export class DraftThrottle {
  private handle: unknown = null;
  private firstAt = 0;

  constructor(
    private readonly clock: DraftClock,
    private readonly fire: () => void,
    private readonly quietMs = DRAFT_QUIET_MS,
    private readonly maxMs = DRAFT_MAX_WAIT_MS,
  ) {}

  /** 打鍵があった。 */
  touch(): void {
    const now = this.clock.now();
    if (this.handle === null) this.firstAt = now;
    else this.clock.clear(this.handle);
    const wait = Math.max(0, Math.min(this.quietMs, this.firstAt + this.maxMs - now));
    this.handle = this.clock.set(() => {
      this.handle = null;
      this.fire();
    }, wait);
  }

  /** 待っている分を今すぐ控える(ページを離れるとき)。 */
  flush(): void {
    if (this.handle === null) return;
    this.clock.clear(this.handle);
    this.handle = null;
    this.fire();
  }

  /** 待っている分をやめる(確定・取り消しのとき)。 */
  cancel(): void {
    if (this.handle === null) return;
    this.clock.clear(this.handle);
    this.handle = null;
  }

  pending(): boolean {
    return this.handle !== null;
  }
}
