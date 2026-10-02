/**
 * 🔴 **パソコンのフォルダを繋ぐ**(#215 段①②。🟣 Gemini 裁定 2026-10-01:
 * 左の列の別のタブ「パソコン」に並べ、**押すと取り込んで開く**)。
 *
 * ## ⚠ handle は**この module だけ**が持つ。state にも IndexedDB にも置かない
 *
 * 設計 doc(`docs/development/local-folder-attach-design-2026-09.md` §3)の 2 つの作法を継ぐ:
 *
 * - **このセッションだけ**(`launched-files.ts` の冒頭が理由を書いている)── 保存すると
 *   「昔どこかで繋いだフォルダ」への権限を黙って持ち続けることになる。
 *   🟣 裁定: **憶えない**(開き直すと「フォルダを選ぶ…」から)。
 * - **reducer に入れない**(`app-state.ts` の注記)── `FileSystemHandle` は不透明で、
 *   比較も複製もできない。
 * ⚠ 「タブを離れても窓を閉じるまで保つ」ために、**描画器ではなくここ**に持つ
 *   (描画器は面を切り替えるたびに器だけ `hidden` にするが、持ち主を 1 つに決めておく)。
 *
 * ## 何をするか(読むだけ)
 *
 * ① `pick()` ── OS のフォルダ選択 → **直下だけ**を列挙 → 名前順 ② 見える分(200 件ずつ)の
 * 大きさ・更新日を読む ③ `open(i)` ── 行の file を読んで `deps.open` へ渡す(取り込みは
 * 既存の口 ── ここは取り込みの規則を持たない)④ `cut()` ── handle を捨てる。
 *
 * 🔴 **消す口・改名・移動は 1 つも作らない**(裁定。`tests/adapter/local-folder.test.ts` が
 * 公開面を全数で見る)。⚠ 書き戻しは**既存の「元ファイルへ書き戻す」**(`launched-files.ts`)が担う。
 *
 * ## 権限の読み方
 *
 * `queryPermission({ mode: 'read' })` が **`'granted'` のときだけ**読む。⚠ `'prompt'` も
 * 「許可が切れた」と読む(`'granted'` と読むと、読めないのに一覧を出して**押すと失敗する**)。
 * ⚠ ここでは `requestPermission` を撃たない ── 切れたら「もう一度フォルダを選んでください」
 * と言い、**選び直し**(= 押した流れの中の許可)へ誘う。
 */
import {
  FOLDER_PAGE,
  fileKindOf,
  sortFolderEntries,
  type FolderFileKind,
} from '@features/local-folder/folder-entries';
import type { LaunchedHandle } from './launched-files';

/** 一覧の 1 件の handle(必要な部分だけ)。 */
export interface FolderEntryHandle extends LaunchedHandle {
  kind: string;
  name: string;
}

/** `FileSystemDirectoryHandle`(必要な部分だけ)。 */
export interface DirectoryHandleLike {
  name: string;
  /** ⚠ 非同期の列挙(本物は `AsyncIterableIterator`)。 */
  values(): AsyncIterable<FolderEntryHandle>;
  queryPermission?(descriptor: { mode: string }): Promise<string>;
}

/** `showDirectoryPicker`。⚠ 無いブラウザ(Firefox / Safari の一部)では `null`。 */
export type DirectoryPicker = (options: { mode: string }) => Promise<DirectoryHandleLike>;

/** 窓の `showDirectoryPicker` を引く(無ければ `null`)。 */
export function windowDirectoryPicker(win: object = window): DirectoryPicker | null {
  const fn = (win as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  if (typeof fn !== 'function') return null;
  return (options) => (fn as (o: { mode: string }) => Promise<DirectoryHandleLike>).call(win, options);
}

/** 取り込みの口へ渡す 1 件。⚠ `handle` は**一覧の handle そのもの**(同じ file の判定に使う)。 */
export interface LocalFileItem {
  file: File;
  handle: LaunchedHandle;
}

export interface LocalFolderDeps {
  /** `null` = このブラウザには無い。 */
  picker: DirectoryPicker | null;
  /**
   * 行を押したときの取り込み。⚠ **終わるまで待つ** ── 待つ間は同じ行を押しても
   * もう一度は呼ばない(同時に 2 回入ると、記憶が付く前に両方が「新しい」と読まれて増える)。
   */
  open(item: LocalFileItem): Promise<void>;
  /** 読めなかったことを画面へ言う口(黙って終えない)。 */
  fail(message: string): void;
  /** 見え方が変わったときに呼ぶ(面を描き直す)。 */
  onChange(): void;
}

export type LocalFolderPhase =
  | 'unsupported'
  | 'none'
  | 'listing'
  | 'listed'
  | 'lost'
  | 'failed';

/** 描画に渡す 1 行。 */
export interface LocalFolderRow {
  /** `open(index)` の添字(並べた全体での位置)。 */
  readonly index: number;
  readonly name: string;
  readonly kind: 'file' | 'directory';
  /** 種類の字(フォルダは「フォルダ」)。 */
  readonly label: string;
  /** 元の file へ書き戻せるか。⚠ フォルダは `false`。 */
  readonly writeBack: boolean;
  readonly size: number | null;
  readonly modified: number | null;
}

export interface LocalFolderView {
  /** 変わるたびに増える(描画器の指紋)。 */
  readonly version: number;
  readonly phase: LocalFolderPhase;
  readonly folderName: string | null;
  /** 列挙の途中の件数(`listing` のとき)。 */
  readonly counted: number;
  readonly total: number;
  readonly rows: readonly LocalFolderRow[];
  /** まだ出していない件数が在るか(「さらに表示」)。 */
  readonly more: boolean;
  /** `failed` のとき、理由。 */
  readonly message: string | null;
}

interface Slot {
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly handle: FolderEntryHandle;
  size: number | null;
  modified: number | null;
  stat: 'todo' | 'done';
}

const DIR_LABEL = 'フォルダ';

export class LocalFolder {
  private dir: DirectoryHandleLike | null = null;
  private phase: LocalFolderPhase;
  private slots: Slot[] = [];
  private counted = 0;
  private shown = 0;
  private message: string | null = null;
  private version = 0;
  /** 「切る」「選び直し」で増える。古い列挙・読み込みの続きを捨てる札。 */
  private generation = 0;
  /** 取り込み中の行(同じ行を同時に 2 度取り込まない)。 */
  private readonly opening = new Set<number>();

  constructor(private readonly deps: LocalFolderDeps) {
    this.phase = deps.picker === null ? 'unsupported' : 'none';
  }

  /** いま持っている handle(無ければ `null`)。⚠ 検査用 ── 「切る」で捨てたかを見る。 */
  heldHandle(): DirectoryHandleLike | null {
    return this.dir;
  }

  view(): LocalFolderView {
    const rows: LocalFolderRow[] = [];
    const upto = Math.min(this.shown, this.slots.length);
    for (let i = 0; i < upto; i++) {
      const s = this.slots[i]!;
      const kind: FolderFileKind | null = s.kind === 'file' ? fileKindOf(s.name) : null;
      rows.push({
        index: i,
        name: s.name,
        kind: s.kind,
        label: kind === null ? DIR_LABEL : kind.label,
        writeBack: kind?.writeBack ?? false,
        size: s.size,
        modified: s.modified,
      });
    }
    return {
      version: this.version,
      phase: this.phase,
      folderName: this.dir?.name ?? null,
      counted: this.counted,
      total: this.slots.length,
      rows,
      more: this.phase === 'listed' && this.shown < this.slots.length,
      message: this.message,
    };
  }

  private changed(): void {
    this.version += 1;
    this.deps.onChange();
  }

  /** 読む許可が在るか。⚠ `'granted'` だけを「在る」と読む(`'prompt'` は切れている)。 */
  private async readable(dir: DirectoryHandleLike): Promise<boolean> {
    // ⚠ `queryPermission` を持たない実装は「許可の概念が無い」ので読める扱い(`writeBackFile` と同じ)
    if (typeof dir.queryPermission !== 'function') return true;
    try {
      return (await dir.queryPermission({ mode: 'read' })) === 'granted';
    } catch {
      return false;
    }
  }

  private lose(): void {
    // ⚠ 切れた handle は使い道が無いので**手放す**(行も消す ── 押せない行を残さない)
    this.generation += 1;
    this.dir = null;
    this.slots = [];
    this.counted = 0;
    this.shown = 0;
    this.phase = 'lost';
    this.message = null;
    this.changed();
  }

  /**
   * 「フォルダを選ぶ…」。⚠ **押した流れの中で呼ぶ**(OS の選択は user の操作が要る)。
   * 選ばずに閉じた(`AbortError`)ときは**何も変えない**(繋いでいたフォルダはそのまま)。
   */
  async pick(): Promise<void> {
    const picker = this.deps.picker;
    if (picker === null) return;
    let dir: DirectoryHandleLike;
    try {
      dir = await picker({ mode: 'read' });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return;
      this.generation += 1;
      this.dir = null;
      this.slots = [];
      this.phase = 'failed';
      this.message = `フォルダを開けませんでした: ${e instanceof Error ? e.message : String(e)}`;
      this.changed();
      return;
    }
    const gen = ++this.generation;
    this.dir = dir;
    this.slots = [];
    this.counted = 0;
    this.shown = 0;
    this.message = null;
    this.phase = 'listing';
    this.changed();

    const found: Slot[] = [];
    try {
      for await (const h of dir.values()) {
        if (gen !== this.generation) return; // 「切る」/ 選び直しが先に押された
        found.push({
          name: h.name,
          kind: h.kind === 'directory' ? 'directory' : 'file',
          handle: h,
          size: null,
          modified: null,
          stat: 'todo',
        });
        this.counted = found.length;
        // ⚠ 200 件ごとに数を見せる(毎件描くと、大きいフォルダで描画が列挙を追い越す)
        if (found.length % FOLDER_PAGE === 0) this.changed();
      }
    } catch (e) {
      if (gen !== this.generation) return;
      if (!(await this.readable(dir))) {
        this.lose();
        return;
      }
      this.phase = 'failed';
      this.message = `フォルダの中を読めませんでした: ${e instanceof Error ? e.message : String(e)}`;
      this.changed();
      return;
    }
    if (gen !== this.generation) return;
    this.slots = sortFolderEntries(found);
    this.shown = Math.min(FOLDER_PAGE, this.slots.length);
    this.phase = 'listed';
    this.changed();
    void this.fillStats(gen);
  }

  /**
   * 見えている行の大きさと更新日を読む。⚠ **見える分だけ**(1 万件のフォルダで
   * 1 万回 `getFile` を撃たない)。読めない行は「—」のまま(0 と読ませない)。
   */
  private async fillStats(gen: number): Promise<void> {
    const upto = Math.min(this.shown, this.slots.length);
    let touched = false;
    for (let i = 0; i < upto; i++) {
      const s = this.slots[i]!;
      if (s.stat === 'done') continue;
      s.stat = 'done';
      if (s.kind !== 'file' || typeof s.handle.getFile !== 'function') continue;
      try {
        const f = await s.handle.getFile();
        if (gen !== this.generation) return;
        s.size = f.size;
        s.modified = f.lastModified;
        touched = true;
      } catch {
        if (gen !== this.generation) return;
      }
    }
    if (touched && gen === this.generation) this.changed();
  }

  /** 「さらに表示」。⚠ 権限が切れていたら、足さずに「切れた」と言う。 */
  async more(): Promise<void> {
    if (this.phase !== 'listed' || this.dir === null) return;
    const gen = this.generation;
    if (!(await this.readable(this.dir))) {
      if (gen === this.generation) this.lose();
      return;
    }
    if (gen !== this.generation) return;
    this.shown = Math.min(this.shown + FOLDER_PAGE, this.slots.length);
    this.changed();
    void this.fillStats(gen);
  }

  /** 「切る」。⚠ **handle を捨てる**(列挙の途中でも効く ── 続きは世代の札で捨てる)。 */
  cut(): void {
    this.generation += 1;
    this.dir = null;
    this.slots = [];
    this.counted = 0;
    this.shown = 0;
    this.message = null;
    this.phase = this.deps.picker === null ? 'unsupported' : 'none';
    this.changed();
  }

  /**
   * 行を押す。file を読んで取り込みの口へ渡す(1 回だけ)。
   * ⚠ フォルダの行・範囲外・取り込み中の行は**何もしない**(押せる見た目にもしていない)。
   */
  async open(index: number): Promise<void> {
    const dir = this.dir;
    const slot = this.slots[index];
    if (dir === null || slot === undefined || slot.kind !== 'file') return;
    if (this.opening.has(index)) return;
    const gen = this.generation;
    this.opening.add(index);
    try {
      if (!(await this.readable(dir))) {
        if (gen === this.generation) this.lose();
        return;
      }
      if (typeof slot.handle.getFile !== 'function') {
        this.deps.fail(`「${slot.name}」を読めませんでした`);
        return;
      }
      let file: File;
      try {
        file = await slot.handle.getFile();
      } catch (e) {
        // ⚠ 消された・名前が変わった・許可が切れた ── 理由を添えて言う(黙って終えない)
        if (!(await this.readable(dir))) {
          if (gen === this.generation) this.lose();
          return;
        }
        this.deps.fail(
          `「${slot.name}」を読めませんでした(消されたか、名前が変わったかもしれません): ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      // ⚠ 読んでいる間に「切る」が押されていたら、取り込まない(切ったのに開く、を作らない)
      if (gen !== this.generation) return;
      await this.deps.open({ file, handle: slot.handle });
    } finally {
      this.opening.delete(index);
    }
  }
}
