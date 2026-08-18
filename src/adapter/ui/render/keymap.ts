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
  defaultBindings,
  findCommand,
  KEY_COMMANDS,
  matchCommand,
  resolveBindings,
  validateBinding,
  type BindingProblem,
  type KeyContext,
  type KeymapBindings,
} from '@features/keymap';

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
    this.cache = resolveBindings(this.readOverrides());
    return this.cache;
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
    const problem = validateBinding(commandId, norm, this.getBindings());
    if (problem !== null) return problem;
    const cur = [...(this.getBindings()[commandId] ?? cmd.defaults)];
    if (!cur.includes(norm)) cur.push(norm);
    this.write(commandId, cur);
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
    const cur = (this.getBindings()[commandId] ?? cmd.defaults).filter((c) => c !== norm);
    this.write(commandId, cur);
  }

  /** そのコマンドを既定へ戻す。 */
  resetCommand(commandId: string): void {
    const next = { ...this.readOverrides() };
    if (next[commandId] === undefined) return;
    delete next[commandId];
    this.save(next);
  }

  /** 全部を既定へ戻す。 */
  resetAll(): void {
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

  private write(commandId: string, chords: readonly string[]): void {
    const cmd = findCommand(commandId);
    if (cmd === null) return;
    const next = { ...this.readOverrides() };
    const same =
      chords.length === cmd.defaults.length && chords.every((c, i) => c === cmd.defaults[i]);
    // 既定と同じ並びに戻ったなら**上書きを消す**(保存に無駄な行を残さない)
    if (same) delete next[commandId];
    else next[commandId] = [...chords];
    this.save(next);
  }

  private save(next: Overrides): void {
    this.overrides = next;
    this.cache = resolveBindings(next);
    try {
      if (Object.keys(next).length === 0) this.storage?.removeItem(KEY);
      else this.storage?.setItem(KEY, JSON.stringify(next));
    } catch {
      // 保存できないだけ ── この session では効いている(憶えている側が持つ)
    }
    for (const fn of this.listeners) fn();
  }

  private readOverrides(): Overrides {
    if (this.overrides !== null) return this.overrides;
    let parsed: unknown;
    try {
      const raw = this.storage?.getItem(KEY);
      parsed = raw === null || raw === undefined ? null : JSON.parse(raw);
    } catch {
      parsed = null; // 壊れた保存で近道が全部死ぬのがいちばん困る ── 既定へ落ちる
    }
    const out: Overrides = {};
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const c of KEY_COMMANDS) {
        const v = (parsed as Record<string, unknown>)[c.id];
        if (!Array.isArray(v)) continue;
        const list: string[] = [];
        for (const item of v) {
          if (typeof item !== 'string') continue;
          const chord = chordFromString(item);
          if (chord === null) continue;
          const norm = chordToString(chord);
          if (!list.includes(norm)) list.push(norm);
        }
        out[c.id] = list;
      }
    }
    this.overrides = out;
    return out;
  }
}

/** アプリ共有の 1 個。⚠ 読む側は必ずこれを引く(`appFlags` / `appEditorMode` と同じ規律)。 */
export const appKeymap = new KeymapStore();

/** 既定だけの割当(test / 表示の対照群)。 */
export const DEFAULT_BINDINGS: KeymapBindings = defaultBindings();
