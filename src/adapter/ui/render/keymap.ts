/**
 * ショートカットの割当の保存(user 指示 2026-08-18)。意味論は `features/keymap.ts`。
 *
 * ⚠ 1 鍵だけ(`pkc3.theme` / `pkc3.editor-mode` と同じ作法)。
 * ⚠ **container に入れない** ── ノートのデータではなく**この端末の手癖**である。
 *   (入れると、書き出した md を配った相手のキー割当まで書き換わる)
 * ⚠ 読めない環境(プライベートモード等)でも落ちない ── 既定に落ちる。
 *
 * ## 🔴 打鍵ごとに保存を読まない
 *
 * `editor-mode.ts` は「読むたびに保存を見る」作法だが、**ここは打鍵ごとに呼ばれる** ──
 * 同じ作法にすると 1 打鍵ごとに `localStorage.getItem` + `JSON.parse` が走る
 * (user 指示 2026-08-03「操作の応答」が主戦場)。だから**憶えておいて、
 * 変わったときだけ読み直す**:
 *   ① 自分で書いたとき(設定画面)── その場で憶え直す
 *   ② **別のタブが書いたとき** ── `storage` event で憶え直す
 * ⚠ ②を省くと「2 枚目のタブで変えた割当が、1 枚目では再読込まで効かない」になる。
 */
import {
  chordOf,
  chordToString,
  chordFromString,
  findCommand,
  KEY_COMMANDS,
  matchCommand,
  resolveUsableBindings,
  validateBinding,
  type BindingProblem,
  type UnusableBinding,
  type KeyContext,
  type KeymapBindings,
} from '@features/keymap';

import { SETTINGS_NOT_PERSISTED_TEXT } from './settings-persist-probe';

const KEY = 'pkc3.keymap';

function readStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 保存の中身。⚠ **上書きしたコマンドだけ**が入る(既定は書かない)。 */
type Overrides = Record<string, string[]>;

export class KeymapStore {
  /** 解決済みの割当。⚠ `null` = まだ読んでいない(遅延で 1 回だけ読む)。 */
  private cache: KeymapBindings | null = null;
  private overrides: Overrides | null = null;
  private unusable: readonly UnusableBinding[] = [];
  /**
   * 🔴 **知らない id の割当**(新しい版で付いた物)。読むときは使わないが、書くときは**そのまま残す**(#1087)。
   * ⚠ 同じオリジンの `/dev/` と `/` は保存を共有する ── 古い版でキーを 1 つ変えただけで、新しい版の割当を
   *   消してはいけない。
   */
  private extras: Record<string, unknown> = {};
  /** 🔴 直近の保存が書けなかった(= 憶えている側だけが正本)。このあいだは保存を読み直さない。 */
  private unsaved = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: Pick<
      Storage,
      'getItem' | 'setItem' | 'removeItem'
    > | null = readStorage(),
  ) {}

  /**
   * 別のタブの書換を拾う。⚠ **返り値で外す**(`dispatcher.onState` と同じ作法。
   * 短命な購読は必ず外す ── 外さないと器を作り直す test で二重に効く)。
   */
  watchOtherTabs(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
    const onStorage = (ev: Event): void => {
      const se = ev as StorageEvent;
      // ⚠ `key === null` は「全消し」(`localStorage.clear()`)── これも読み直す
      if (se.key !== null && se.key !== KEY) return;
      this.cache = null;
      this.overrides = null;
      this.unsaved = false;
      for (const fn of this.listeners) fn();
    };
    target.addEventListener('storage', onStorage);
    return () => target.removeEventListener('storage', onStorage);
  }

  /** 割当が変わったら呼ばれる(設定画面が自分を描き直すため)。 */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** いま効いている割当(既定 + 上書き)。 */
  getBindings(): KeymapBindings {
    if (this.cache !== null) return this.cache;
    const r = resolveUsableBindings(this.readOverrides());
    this.cache = r.bindings;
    this.unusable = r.unusable;
    return this.cache;
  }

  /** 読み込んだ割当のうち、検査を通らず使っていない物(保存には残っている)。 */
  getUnusable(): readonly UnusableBinding[] {
    this.getBindings();
    return this.unusable;
  }

  /** 上書きだけ(設定画面が「既定のままか」を出すのに使う)。 */
  getOverrides(): Readonly<Overrides> {
    return this.readOverrides();
  }

  /** そのコマンドが既定のままか。 */
  isDefault(commandId: string): boolean {
    return this.readOverrides()[commandId] === undefined;
  }

  /**
   * 割当を 1 つ足す。
   * @returns 断った理由(読めない / 修飾なし / 予約済み / 衝突)。足せたら `null`。
   */
  addBinding(commandId: string, chord: string): BindingProblem | null {
    const cmd = findCommand(commandId);
    if (cmd === null) return { kind: 'unreadable', message: '知らないコマンドです' };
    const parsed = chordFromString(chord);
    if (parsed === null) return { kind: 'unreadable', message: 'このキーは割り当てられません' };
    const norm = chordToString(parsed);
    // 🔴 同じタブの別の経路(設定ファイルの読み込み)が保存へ直に書いていても、古い憶えで上書きしない
    this.refresh();
    // 🔴 すでに付いているのに黙って終わらない(押した user には「何も起きなかった」と見える)
    if ((this.getBindings()[commandId] ?? cmd.defaults).includes(norm)) {
      return { kind: 'duplicate', message: 'もう割り当ててあります' };
    }
    const problem = validateBinding(commandId, norm, this.getBindings());
    if (problem !== null) return problem;
    // ⚠ 土台は**保存してある並び**(使えない割当も含む)── 使える物だけで書き直すと、使えない割当が保存から消える
    const cur = [...(this.readOverrides()[commandId] ?? cmd.defaults)];
    if (!cur.includes(norm)) cur.push(norm);
    if (!this.write(commandId, cur)) {
      // 割り当て自体はこの session で効いている ── 書けなかったことだけを言う
      return { kind: 'unsaved', message: SETTINGS_NOT_PERSISTED_TEXT };
    }
    return null;
  }

  /**
   * 割当を 1 つ外す。⚠ **最後の 1 つも外せる**(「この近道は要らない」を尊重する)──
   * 戻し道は「既定に戻す」なので、行き止まりにはならない。
   */
  removeBinding(commandId: string, chord: string): void {
    const cmd = findCommand(commandId);
    if (cmd === null) return;
    const parsed = chordFromString(chord);
    if (parsed === null) return;
    const norm = chordToString(parsed);
    this.refresh();
    const cur = (this.readOverrides()[commandId] ?? cmd.defaults).filter((c) => c !== norm);
    this.write(commandId, cur);
  }

  /** そのコマンドを既定へ戻す。 */
  resetCommand(commandId: string): void {
    this.refresh();
    const next = { ...this.readOverrides() };
    if (next[commandId] === undefined) return;
    delete next[commandId];
    this.save(next);
  }

  /** 全部を既定へ戻す。 */
  resetAll(): void {
    this.refresh();
    this.save({});
  }

  /**
   * 打鍵 → コマンド id。⚠ 呼び手は**自分の面を名乗る**(`global` / `editor` / `row` / `live`)。
   */
  match(
    ev: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
    context: KeyContext,
  ): string | null {
    return matchCommand(chordOf(ev), context, this.getBindings());
  }

  /**
   * 保存を読み直して憶えを合わせる。⚠ **書く前に必ず通る**(#1087)── 憶えは起動時と `storage` event でしか
   * 更新されないので、同じタブの別の経路(設定ファイルの読み込みは `localStorage` へ直に書く)が書いた分を
   * 知らないまま書き直すと、読み込んだ割当が全部消えていた。
   * 打鍵ごとには通らない(割り当て・外す・戻すの操作だけ)。
   * ⚠ 読めないとき(保存が使えない / 直近の保存が書けていない)は憶えを正本にする。
   */
  private refresh(): void {
    if (this.unsaved) return;
    const loaded = this.load();
    if (loaded === null) return;
    this.overrides = loaded.known;
    this.extras = loaded.extras;
    this.cache = null;
  }

  private write(commandId: string, chords: readonly string[]): boolean {
    const cmd = findCommand(commandId);
    if (cmd === null) return true;
    const next = { ...this.readOverrides() };
    const same =
      chords.length === cmd.defaults.length && chords.every((c, i) => c === cmd.defaults[i]);
    // 既定と同じ並びに戻ったなら**上書きを消す**(保存に無駄な行を残さない)
    if (same) delete next[commandId];
    else next[commandId] = [...chords];
    return this.save(next);
  }

  /** @returns 保存に書けたか。⚠ 書けなくても、この session では効く(憶えている側が持つ)。 */
  private save(next: Overrides): boolean {
    this.overrides = next;
    this.cache = null;
    let ok = this.storage !== null;
    try {
      // ⚠ 知らない id はそのまま書き戻す(新しい版の割当を消さない)。既知の id は `next` が勝つ
      const out: Record<string, unknown> = { ...this.extras, ...next };
      if (Object.keys(out).length === 0) this.storage?.removeItem(KEY);
      else this.storage?.setItem(KEY, JSON.stringify(out));
    } catch {
      ok = false;
    }
    this.unsaved = !ok;
    for (const fn of this.listeners) fn();
    return ok;
  }

  private readOverrides(): Overrides {
    if (this.overrides !== null) return this.overrides;
    const loaded = this.load();
    this.overrides = loaded?.known ?? {};
    this.extras = loaded?.extras ?? {};
    return this.overrides;
  }

  /** 保存を読む。`null` = 保存が読めない(使えない / 例外)。⚠ 壊れた中身は「何も無い」として返す。 */
  private load(): { known: Overrides; extras: Record<string, unknown> } | null {
    let parsed: unknown;
    try {
      if (this.storage === null) return null;
      const raw = this.storage.getItem(KEY);
      parsed = raw === null || raw === undefined ? null : JSON.parse(raw);
    } catch (e) {
      if (e instanceof SyntaxError) parsed = null; // 壊れた保存で近道が全部死ぬのがいちばん困る ── 既定へ落ちる
      else return null;
    }
    const known: Overrides = {};
    const extras: Record<string, unknown> = {};
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const ids = new Set(KEY_COMMANDS.map((c) => c.id));
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!ids.has(id) || !Array.isArray(v)) {
          extras[id] = v; // 知らない id / 形の違う値は触らずに残す
          continue;
        }
        const list: string[] = [];
        for (const item of v) {
          if (typeof item !== 'string') continue;
          const chord = chordFromString(item);
          if (chord === null) continue;
          const norm = chordToString(chord);
          if (!list.includes(norm)) list.push(norm);
        }
        known[id] = list;
      }
    }
    return { known, extras };
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appFlags` / `appEditorMode` と同じ規律)。 */
export const appKeymap = new KeymapStore();
