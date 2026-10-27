/**
 * 🔴 **ワークスペースの切り替え**(#1455。user 裁定 2026-10 の推薦 = 「仕事用 / 個人用のように、ノートの束を
 * 2 つ以上持って画面から切り替える」)。
 *
 * ## 何か
 *
 * ワークスペース = 保存領域の中の**器(コンテナ)1 つ**。ノート・つながり・履歴・添付の目録・タグの色は
 * 全部 `cid` で区切られているので、**切り替え = 次に開く器を替えて読み込み直す**だけで済む。
 * 保存の形(表の列)は 1 つも変えない ── 切り替えの印は `workspaces` 表の 1 行(今まで誰も使っていなかった表)。
 *
 * ## 守っていること
 *
 * - 🔴 **自動では動かない**。作る・切り替える・名前を直す・削除する、は押した user だけが打つ。
 * - 🔴 **書込の列に載せる**(`run`)── 保存の途中に切り替えて、書きかけの 1 件を別の器へ落とさない。
 * - 🔴 **削除は使っていない器だけ / 最後の 1 つは残す**(worker が断る。ここは理由を言い換える)。
 * - 🔴 **切り替えたら読み込み直す**(`reload`)── 画面・検索の索引・開いている本文は全部前の器の物。
 *   ⚠ 読み込み直すまで、ほかの操作は前の器へ書く(切り替えの印を書いただけでは、いまの画面は動かない)。
 * - 🔑 画面は `view()` を映すだけ。判断(押せるか・断る文)はここに 1 か所。
 */
import type { ResultMap } from './protocol';

export interface WorkspaceDeps {
  /** worker の `listWorkspaces`(読むだけ)。 */
  list(): Promise<ResultMap['listWorkspaces']>;
  create(title: string): Promise<string>;
  switchTo(cid: string): Promise<void>;
  rename(cid: string, title: string): Promise<void>;
  remove(cid: string): Promise<{ removedNotes: number }>;
  /** 書込の列に載せて走らせる(`StoreEffects.run`)。 */
  run<T>(job: () => Promise<T>): Promise<T>;
  /** 画面ごと読み込み直す。 */
  reload(): void;
  /**
   * 🔴 **その器を、ほかのタブが開いているか**(#1455 レビュー ⚠3)。Web Locks(`pkc3-ws:<cid>` を各タブが shared で握る)で見る。
   * ⚠ 省略 = 確かめる手段が無い環境(Web Locks が無い)。確かめられないときは、確認の文で「ほかのタブで開いていないこと」を言う。
   */
  isOpenElsewhere?(cid: string): Promise<boolean>;
  /**
   * 🔴 **保存していない編集・打ちかけが在るか**(#1455 レビュー ⚠5)。読み込み直しは本文を**確認なしで捨てる**
   * (本文は画面の状態にしか無い)── 切り替える前に聞く。`update-card` の `isEditing` / `confirmDiscard` と同じ型。
   */
  isEditing?(): boolean;
  /** 捨ててよいか聞く(アプリ自身の確認)。 */
  confirmDiscard?(): Promise<boolean>;
}

/** 開いているタブが居る器の削除を断る文。 */
export const WORKSPACE_OPEN_ELSEWHERE_TEXT =
  'その器はほかのタブで開かれているため、削除できません(そのタブを閉じてから、もう一度押してください)';
/** 確かめる手段が無い環境で、削除の確認に添える一文。 */
export const WORKSPACE_OPEN_UNCHECKED_TEXT =
  'ほかのタブで、このワークスペースを開いていないことを確かめてから削除してください(この環境では自動では確かめられません)。';

/** 画面に出す 1 行。 */
export interface WorkspaceRow {
  readonly cid: string;
  readonly title: string;
  readonly notes: number;
  /** いま開いている器か(= このタブが書いている器)。 */
  readonly current: boolean;
  /** 次に開く器か(切り替えの印が指す器)。`current` と違うのは、切り替えて読み込み直す前の短い間だけ。 */
  readonly next: boolean;
}

export interface WorkspaceView {
  /** 配線が無い環境(可搬の単一 HTML)では節ごと隠す。 */
  readonly attached: boolean;
  readonly rows: readonly WorkspaceRow[];
  readonly busy: boolean;
  /** 「ほかのタブで開いているか」を自動で確かめられるか(`false` のとき、削除の確認に一文を添える)。 */
  readonly canCheckOpen: boolean;
  /** 一覧の下に出す 1 行(読み込み中 / 失敗 / 前回の結果)。 */
  readonly note: string;
}

export type WorkspaceResult =
  | { readonly kind: 'done'; readonly text: string }
  /** 確認で「やめる」と答えた。⚠ 何も変えていない・何も言わない(やめた人を責めない)。 */
  | { readonly kind: 'cancelled'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string }
  | { readonly kind: 'refused'; readonly text: string };

const NOTE_LOADING = 'ワークスペースを調べています…';
const NOTE_FAILED = 'ワークスペースの一覧を読めませんでした';
export const WORKSPACE_NAME_EMPTY = 'ワークスペースの名前を入れてください';

/** 例外の字を、画面に出せる文へ(worker の断り文はそのまま日本語で届く)。 */
function reasonOf(e: unknown): string {
  const t = e instanceof Error ? e.message : String(e);
  return t === '' ? 'うまくいきませんでした' : t;
}

export class Workspaces {
  private deps: WorkspaceDeps | null = null;
  private rows: readonly WorkspaceRow[] = [];
  private loaded = false;
  private failed = false;
  private busy = false;
  private last = '';
  /** このタブが書いている器(起動のときに決めた cid)。 */
  private currentCid: string | null = null;
  private readonly listeners = new Set<() => void>();

  /** 配線を渡す(`main.ts` が boot で 1 度)。⚠ 可搬の単一 HTML では渡さない。 */
  attach(deps: WorkspaceDeps, currentCid: string): void {
    this.deps = deps;
    this.currentCid = currentCid;
    this.loaded = false;
    this.notify();
  }

  view(): WorkspaceView {
    if (this.deps === null) return { attached: false, rows: [], busy: false, canCheckOpen: false, note: '' };
    const note = this.busy
      ? '処理しています…'
      : this.failed
        ? NOTE_FAILED
        : !this.loaded
          ? NOTE_LOADING
          : this.last;
    return {
      attached: true,
      rows: this.rows,
      busy: this.busy,
      canCheckOpen: this.deps.isOpenElsewhere !== undefined,
      note,
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 一覧を読み直す。設定を開いたときと、操作の後に呼ぶ。 */
  async refresh(): Promise<void> {
    const d = this.deps;
    if (d === null) return;
    try {
      const list = await d.list();
      this.rows = list.workspaces.map((w) => ({
        cid: w.cid,
        title: w.title === '' ? '(名前なし)' : w.title,
        notes: w.notes,
        current: w.cid === this.currentCid,
        next: w.cid === list.activeCid,
      }));
      this.loaded = true;
      this.failed = false;
    } catch {
      this.failed = true;
    }
    this.notify();
  }

  /** 名前を付けて空のワークスペースを足す。⚠ 切り替えはしない(足しただけでは画面は動かない)。 */
  async create(title: string): Promise<WorkspaceResult> {
    const name = title.replace(/\s+/g, ' ').trim();
    if (name === '') return { kind: 'refused', text: WORKSPACE_NAME_EMPTY };
    return this.act(async (d) => {
      await d.run(() => d.create(name));
      return `ワークスペース「${name}」を作りました(切り替えるには、一覧の「切り替える」を押します)`;
    });
  }

  /** 切り替えて、画面を読み込み直す。 */
  async switchTo(cid: string): Promise<WorkspaceResult> {
    const row = this.rows.find((r) => r.cid === cid);
    if (row === undefined) return { kind: 'refused', text: 'そのワークスペースは一覧にありません(開き直してください)' };
    if (row.next && row.current) return { kind: 'refused', text: 'いま使っているワークスペースです' };
    // 🔴 読み込み直しは打ちかけを捨てる ── 編集中なら、切り替える前に聞く(断られたら何も変えない)
    const g = this.deps;
    if (g?.isEditing?.() === true && !((await g.confirmDiscard?.()) ?? true))
      return { kind: 'cancelled', text: '切り替えをやめました' };
    return this.act(async (d) => {
      await d.run(() => d.switchTo(cid));
      // 🔑 読み込み直す。⚠ これより後に何も書かない(前の器の画面が、新しい器の印を知らずに書き戻さない)
      d.reload();
      return `「${row.title}」へ切り替えます…`;
    });
  }

  async rename(cid: string, title: string): Promise<WorkspaceResult> {
    const name = title.replace(/\s+/g, ' ').trim();
    if (name === '') return { kind: 'refused', text: WORKSPACE_NAME_EMPTY };
    return this.act(async (d) => {
      await d.run(() => d.rename(cid, name));
      return `名前を「${name}」に直しました`;
    });
  }

  async remove(cid: string): Promise<WorkspaceResult> {
    const row = this.rows.find((r) => r.cid === cid);
    if (row === undefined) return { kind: 'refused', text: 'そのワークスペースは一覧にありません(開き直してください)' };
    if (row.current || row.next)
      return { kind: 'refused', text: '使っているワークスペースは削除できません(先に別のワークスペースへ切り替えてください)' };
    return this.act(async (d) => {
      // 🔴 ほかのタブが開いている器は消さない(開いたままのタブは、消えた器へ書き続けて壊れる)。確かめられない環境は確認の文が言う
      if (d.isOpenElsewhere !== undefined && (await d.isOpenElsewhere(cid)))
        throw new Error(WORKSPACE_OPEN_ELSEWHERE_TEXT);
      const r = await d.run(() => d.remove(cid));
      return `「${row.title}」を削除しました(ノート ${r.removedNotes} 件)`;
    });
  }

  private async act(job: (d: WorkspaceDeps) => Promise<string>): Promise<WorkspaceResult> {
    const d = this.deps;
    if (d === null) return { kind: 'refused', text: 'この環境ではワークスペースを切り替えられません' };
    if (this.busy) return { kind: 'refused', text: '別の操作が終わるまでお待ちください' };
    this.busy = true;
    this.notify();
    try {
      const text = await job(d);
      this.last = text;
      this.busy = false;
      await this.refresh();
      return { kind: 'done', text };
    } catch (e) {
      const text = reasonOf(e);
      this.last = text;
      this.busy = false;
      await this.refresh();
      return { kind: 'failed', text };
    }
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** アプリ共有の 1 個。 */
export const appWorkspaces = new Workspaces();
