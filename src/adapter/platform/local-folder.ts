/**
 * 🔴 **パソコンのフォルダを繋ぐ**(#215 段①②。🟣 Gemini 裁定 2026-10-01:
 * 左の列の別のタブ「PC」に並べ、**押すと取り込んで開く**)。
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
 * ① `pick()` ── OS のフォルダ選択 → **開いている階層の直下だけ**を列挙 → 名前順(見せるのは 200 件ずつ)
 * ② `open(i)` ── 行の file を読んで `deps.open` へ渡す(取り込みは既存の口 ──
 * ここは取り込みの規則を持たない)③ `cut()` ── handle を捨てる ④ `refresh()` ── 同じ handle で列挙し直す
 * ⑤ `enter(i)` / `goTo(level)` ── サブフォルダへ入る / パンくずで上の階層へ戻る(#215)
 * ⑥ `pickFile()` ── Office の file を 1 つ選んで開く(#432。フォルダを繋がなくてよい)。
 *
 * ## 🔴 階層(#215)
 *
 * 選んだフォルダ(根)から**サブフォルダの handle を辿る**。`stack[0]` が根、末尾が「いま見ている階層」。
 * 戻るのは**スタックを切り詰めるだけ**(handle は根から辿った物をそのまま使う ── 名前から開き直さない)。
 * ⚠ 階層の移動でも一覧では `getFile()` を呼ばない(#1271)。
 * ⚠ 開いている階層は**名前の並び**だけを端末に憶える(`deps.place`。handle は憶えない ──
 * 上の「このセッションだけ」)。同じ名前のフォルダを選び直すと、憶えた階層へ戻る(無ければ根のまま)。
 *
 * ## 🔴 一覧を出すとき、`getFile()` を 1 件も呼ばない(#1271)
 *
 * かつては見える 200 件の大きさ・更新日を出すために、各行の `getFile()` を呼んでいた。
 * ⚠ OneDrive / iCloud Drive / Dropbox の「ファイルオンデマンド」のフォルダでは、OS は
 * `getFile()` を**「実体の要求」と読み**、まだ手元に無い file を**一斉にダウンロードする**
 * (一覧を出しただけで数十〜数百件。通信とディスクを食う ── Gemini の実機報告)。
 * 🔑 **`getFile()` は「その 1 件を取り込む」と user が押した `open(i)` の中だけ**で呼ぶ。
 * 大きさ・更新日は**一覧では出さない**(描画器が「—」を出す)。⚠ 「大きさも見せたい」と思っても、
 * 一覧で `getFile()` / `stat` 相当を呼ばない ── 手元に在る物だけ読む、は判別できない
 * (File System Access API に「実体が手元に在るか」を訊く口は無い)。
 * 門は `tests/adapter/local-folder.test.ts`(`pick` / `more` の後に `getFile` が 0 回)。
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
import { errorText } from '@features/error-text';
import {
  FOLDER_PAGE,
  fileKindOf,
  sortFolderEntries,
  type FolderFileKind,
} from '@features/local-folder/folder-entries';
import { OFFICE_LAUNCH_EXTS } from '@features/office/office-launch';
import type { LaunchedHandle } from './launched-files';

/** 一覧の 1 件の handle(必要な部分だけ)。 */
export interface FolderEntryHandle extends LaunchedHandle {
  kind: string;
  name: string;
}

/** `FileSystemDirectoryHandle`(必要な部分だけ)。 */
export interface DirectoryHandleLike {
  name: string;
  /** 名前から子のフォルダを引く(憶えた階層へ戻るときだけ使う)。 */
  getDirectoryHandle?(name: string): Promise<DirectoryHandleLike>;
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

/**
 * `showOpenFilePicker` の返り(必要な部分だけ)。
 * ⚠ `<input type=file>` の代わり(handle を持たない)も同じ形で返す ── 書き戻せないので保存はダウンロードになる。
 */
export interface PickedFile {
  file: File;
  handle: LaunchedHandle;
}

/** Office の file を 1 つ選ぶ。選ばずに閉じたら `null`。⚠ 押した流れの中で呼ぶ。 */
export type FilePicker = () => Promise<PickedFile | null>;

/**
 * 🔴 **Office の file を選ぶ口**(#432)。`showOpenFilePicker` があれば **handle を持って**(書き戻せる)返し、
 * 無いブラウザでは `<input type=file>` で選ぶ(handle は無い = 保存はダウンロード)。どちらも無ければ `null`。
 */
export function windowFilePicker(win: object = window): FilePicker | null {
  const w = win as {
    showOpenFilePicker?: unknown;
    document?: Document;
  };
  if (typeof w.showOpenFilePicker === 'function') {
    const fn = w.showOpenFilePicker as (o: object) => Promise<LaunchedHandle[]>;
    return async () => {
      let handles: LaunchedHandle[];
      try {
        handles = await fn.call(win, {
          multiple: false,
          // ⚠ 古いブラウザは未知の option を無視する。対応していれば、選ぶ時点で書き込みの許可も取れる
          mode: 'readwrite',
          types: [{ description: 'Office の文書', accept: { 'application/octet-stream': [...OFFICE_LAUNCH_EXTS] } }],
        });
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return null;
        throw e;
      }
      const handle = handles[0];
      if (handle === undefined || typeof handle.getFile !== 'function') return null;
      return { file: await handle.getFile(), handle };
    };
  }
  const doc = w.document;
  if (doc === undefined) return null;
  return () =>
    new Promise<PickedFile | null>((resolve) => {
      const input = doc.createElement('input');
      input.type = 'file';
      input.accept = OFFICE_LAUNCH_EXTS.join(',');
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        resolve(file === undefined ? null : { file, handle: { kind: 'file', getFile: async () => file } });
      });
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
}

/** 開いている階層の記憶(端末側。根のフォルダ名と、そこからのフォルダ名の並び)。 */
export interface FolderPlace {
  readonly root: string;
  readonly path: readonly string[];
}

export interface FolderPlaceMemory {
  get(): FolderPlace | null;
  set(place: FolderPlace): void;
}

/** 取り込みの口へ渡す 1 件。⚠ `handle` は**一覧の handle そのもの**(同じ file の判定に使う)。 */
export interface LocalFileItem {
  file: File;
  handle: LaunchedHandle;
}

export interface LocalFolderDeps {
  /** `null` = このブラウザには無い。 */
  picker: DirectoryPicker | null;
  /** Office の file を選ぶ口(#432)。省くか `null` = 使えない。 */
  filePicker?: FilePicker | null;
  /** 開いている階層の記憶(#215)。省くと憶えない。 */
  place?: FolderPlaceMemory;
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
}

/** パンくずの 1 つ。`level` 0 = 選んだフォルダ(根)。 */
export interface LocalFolderCrumb {
  readonly name: string;
  readonly level: number;
}

export interface LocalFolderView {
  /** 変わるたびに増える(描画器の指紋)。 */
  readonly version: number;
  readonly phase: LocalFolderPhase;
  readonly folderName: string | null;
  /** 根から、いま見ている階層までの並び(根が先頭)。繋いでいないときは空。 */
  readonly crumbs: readonly LocalFolderCrumb[];
  /** Office の file を選ぶ口が使えるか。 */
  readonly canPickFile: boolean;
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
}

const DIR_LABEL = 'フォルダ';

export class LocalFolder {
  /** 根から、いま見ている階層までの handle(`stack[0]` が根)。空 = 繋いでいない。 */
  private stack: DirectoryHandleLike[] = [];
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

  /** いま見ている階層(無ければ `null`)。 */
  private get dir(): DirectoryHandleLike | null {
    return this.stack[this.stack.length - 1] ?? null;
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
      });
    }
    return {
      version: this.version,
      phase: this.phase,
      folderName: this.dir?.name ?? null,
      crumbs: this.stack.map((d, level) => ({ name: d.name, level })),
      canPickFile: (this.deps.filePicker ?? null) !== null,
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
    this.stack = [];
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
      this.stack = [];
      this.slots = [];
      this.phase = 'failed';
      // ⚠ ブラウザの英語の理由は括弧へ。次にすることを先に言う(#1087)
      this.message = `フォルダを開けませんでした。別のフォルダを選んでください(${errorText(e)})`;
      this.changed();
      return;
    }
    const gen = ++this.generation;
    this.stack = [dir];
    await this.restorePlace(dir);
    if (gen !== this.generation) return; // 復元の途中で「切る」/ 選び直しが先に押された
    this.remember();
    await this.load(this.dir!);
  }

  /** 憶えた階層へ戻る(同じ名前の根のときだけ)。⚠ 途中で辿れなければそこで止める(根のまま / 辿れた所まで)。 */
  private async restorePlace(root: DirectoryHandleLike): Promise<void> {
    const saved = this.deps.place?.get() ?? null;
    if (saved === null || saved.root !== root.name) return;
    let cur = root;
    for (const name of saved.path) {
      if (typeof cur.getDirectoryHandle !== 'function') return;
      try {
        cur = await cur.getDirectoryHandle(name);
      } catch {
        return; // 消えた・名前が変わった・許可が切れた ── 辿れた所まで
      }
      this.stack.push(cur);
    }
  }

  /** いまの階層を端末へ憶える(根の名前と、そこからのフォルダ名の並び)。 */
  private remember(): void {
    const root = this.stack[0];
    if (root === undefined) return;
    this.deps.place?.set({ root: root.name, path: this.stack.slice(1).map((d) => d.name) });
  }

  /**
   * サブフォルダの行を押す。**その中へ入る**(#215)。
   * ⚠ フォルダでない行・範囲外は何もしない。⚠ 権限が切れていたら入らずに「切れた」と言う。
   * ⚠ 一覧の列挙(名前と種類だけ)── `getFile()` は呼ばない(#1271)。
   */
  async enter(index: number): Promise<void> {
    const slot = this.slots[index];
    if (this.dir === null || slot === undefined || slot.kind !== 'directory') return;
    if (this.phase !== 'listed') return;
    const child = slot.handle as unknown as DirectoryHandleLike;
    if (typeof child.values !== 'function') return;
    const gen = this.generation;
    if (!(await this.readable(this.dir))) {
      if (gen === this.generation) this.lose();
      return;
    }
    if (gen !== this.generation) return;
    this.stack.push(child);
    this.remember();
    await this.load(child);
  }

  /**
   * パンくずを押す。**上の階層へ戻る**(`level` 0 = 選んだフォルダ)。
   * ⚠ いまの階層・範囲外は何もしない。⚠ 戻るのは**スタックの切り詰め** ── 名前から開き直さない。
   */
  async goTo(level: number): Promise<void> {
    if (!Number.isInteger(level) || level < 0 || level >= this.stack.length - 1) return;
    if (this.phase !== 'listed' && this.phase !== 'failed') return;
    this.stack = this.stack.slice(0, level + 1);
    this.remember();
    await this.load(this.dir!);
  }

  /**
   * 「Office のファイルを開く…」(#432)。1 つ選んで、行を押したときと**同じ口**(`deps.open`)へ渡す。
   * ⚠ **押した流れの中で呼ぶ**(選択は user の操作が要る)。⚠ 選ばずに閉じたら何もしない。
   * ⚠ フォルダを繋いでいなくても使える(繋ぎには触らない)。
   */
  async pickFile(): Promise<void> {
    const picker = this.deps.filePicker ?? null;
    if (picker === null) return;
    let picked: PickedFile | null;
    try {
      picked = await picker();
    } catch (e) {
      this.deps.fail(`ファイルを開けませんでした。もう一度選んでください(${errorText(e)})`);
      return;
    }
    if (picked === null) return;
    await this.deps.open({ file: picked.file, handle: picked.handle });
  }

  /**
   * 「更新」(#1264 §2 欠陥 4-a)。**同じ handle** で一覧を読み直す ── 外で足した・消した・
   * 名前を変えたファイルが一覧に出る(取り込んだ時点の写しのままだった)。
   * ⚠ **名前と種類だけ**を読む(`getFile()` を呼ばない = #1271)。⚠ 権限が切れていたら
   * 読み直さずに「切れた」と言う(`more` と同じ)。⚠ 繋いでいないときは何もしない。
   */
  async refresh(): Promise<void> {
    const dir = this.dir;
    if (dir === null || (this.phase !== 'listed' && this.phase !== 'failed')) return;
    const gen = this.generation;
    if (!(await this.readable(dir))) {
      if (gen === this.generation) this.lose();
      return;
    }
    if (gen !== this.generation) return;
    await this.load(dir);
  }

  /** 直下を列挙して並べる(`pick` と `refresh` の共通の本体)。 */
  private async load(dir: DirectoryHandleLike): Promise<void> {
    const gen = ++this.generation;
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
      this.message = `フォルダの中を読めませんでした。もう一度フォルダを選び直してください(${errorText(e)})`;
      this.changed();
      return;
    }
    if (gen !== this.generation) return;
    this.slots = sortFolderEntries(found);
    this.shown = Math.min(FOLDER_PAGE, this.slots.length);
    this.phase = 'listed';
    this.changed();
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
  }

  /** 「切る」。⚠ **handle を捨てる**(列挙の途中でも効く ── 続きは世代の札で捨てる)。 */
  cut(): void {
    this.generation += 1;
    this.stack = [];
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
          `「${slot.name}」を読めませんでした。消されたか、名前が変わったかもしれません(${errorText(e)})`,
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
