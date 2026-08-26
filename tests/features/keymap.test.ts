/**
 * ショートカットキーの割当(#256。user 指示 2026-08-18
 * 「PKC2 相当以上のショートカットキー機能とショートカットキーのカスタマイズ機能、
 * デフォルトは PKC2 の操作感に寄せること」)。
 *
 * 🔴 守る主張:
 * 1. **Ctrl と ⌘ は同じ**(PKC2 は片方の経路で厳密比較していて mac で沈黙した)
 * 2. **同じ物理キーは 1 つの名前になる**(`code` があってもなくても)
 * 3. **既定そのものが自分の検査を通る**(守れない条件を書かない ── CLAUDE.md §1)
 * 4. **文脈が重ならない割当はぶつかっていない**(行の Tab と編集の Tab は別)
 * 5. 壊れた保存で**近道が全部死なない**
 */
import { describe, expect, it } from 'vitest';
import {
  KEY_COMMANDS,
  baseKeyOf,
  chordFromString,
  chordLabel,
  chordOf,
  chordToString,
  contextsOverlap,
  defaultBindings,
  findCommand,
  matchCommand,
  resolveBindings,
  sameChord,
  validateBinding,
  type KeyContext,
} from '../../src/features/keymap';
import { isAsidePane, type ViewMode } from '../../src/adapter/state/app-state';

/** `KeyboardEvent` の形だけ作る(happy-dom を要らなくする ── ここは純関数)。 */
function ev(
  init: Partial<{
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }>,
): {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
} {
  return {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  };
}

describe('打鍵 → 和音', () => {
  it('🔴 Ctrl と ⌘ は同じ割当になる(mac で沈黙する近道を作らない)', () => {
    const ctrl = chordOf(ev({ key: 'n', code: 'KeyN', ctrlKey: true }));
    const cmd = chordOf(ev({ key: 'n', code: 'KeyN', metaKey: true }));
    expect(ctrl).not.toBeNull();
    expect(chordToString(ctrl!)).toBe('Mod+N');
    expect(chordToString(cmd!)).toBe('Mod+N');
  });

  it('🔴 `code` があるときは修飾で化けない(mac の Alt+[ は key が別物になる)', () => {
    // mac で Option+[ を押すと `key` は `“`。`code` を見ていれば同じ物理キーである
    const macAlt = chordOf(ev({ key: '“', code: 'BracketLeft', altKey: true }));
    const winAlt = chordOf(ev({ key: '[', code: 'BracketLeft', altKey: true }));
    expect(chordToString(macAlt!)).toBe('Alt+BracketLeft');
    expect(chordToString(winAlt!)).toBe('Alt+BracketLeft');
  });

  it('🔴 `code` が無い打鍵も同じ名前へ寄せる(合成 event / 仮想キーボード)', () => {
    // ⚠ ここが無いと `[` と `BracketLeft` が別名になり、**割当が片方でしか効かない**
    expect(chordToString(chordOf(ev({ key: '[', altKey: true }))!)).toBe('Alt+BracketLeft');
    expect(chordToString(chordOf(ev({ key: '?', ctrlKey: true, shiftKey: true }))!)).toBe(
      'Mod+Shift+Slash',
    );
    expect(chordToString(chordOf(ev({ key: 'b', ctrlKey: true }))!)).toBe('Mod+B');
    expect(chordToString(chordOf(ev({ key: ' ' }))!)).toBe('Space');
  });

  it('修飾キー単独は割当にならない', () => {
    expect(chordOf(ev({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(chordOf(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(baseKeyOf(ev({ key: 'Meta' }))).toBeNull();
  });

  it('名前つきキーはそのまま(F キー / 矢印 / Escape)', () => {
    expect(baseKeyOf(ev({ key: 'F1', code: 'F1' }))).toBe('F1');
    expect(baseKeyOf(ev({ key: 'ArrowLeft', code: 'ArrowLeft' }))).toBe('ArrowLeft');
    expect(baseKeyOf(ev({ key: 'Escape', code: 'Escape' }))).toBe('Escape');
    // NumpadEnter は Enter と同じ意味へ寄せる(押した人にとって同じ鍵)
    expect(baseKeyOf(ev({ key: 'Enter', code: 'NumpadEnter' }))).toBe('Enter');
  });
});

describe('文字列との往復', () => {
  it('修飾語の綴りは吸収する(Ctrl / Cmd / Meta / Mod)', () => {
    expect(sameChord('Ctrl+B', 'Mod+B')).toBe(true);
    expect(sameChord('Cmd+b', 'Mod+B')).toBe(true);
    expect(sameChord('Meta+B', 'Mod+B')).toBe(true);
    expect(sameChord('Alt+B', 'Mod+B')).toBe(false);
  });

  it('刻印で書いても同じ物理キーに寄る', () => {
    expect(sameChord('Alt+[', 'Alt+BracketLeft')).toBe(true);
    expect(sameChord('Mod+,', 'Mod+Comma')).toBe(true);
  });

  it('知らない修飾語は黙って落とさない(null を返す)', () => {
    expect(chordFromString('Hyper+B')).toBeNull();
    expect(chordFromString('')).toBeNull();
  });

  it('画面に出す形は mac と win で変わる(割当そのものは 1 つ)', () => {
    expect(chordLabel('Mod+Shift+Z', false)).toBe('Ctrl + Shift + Z');
    expect(chordLabel('Mod+Shift+Z', true)).toBe('⌘ + ⇧ + Z');
    expect(chordLabel('Alt+BracketLeft', false)).toBe('Alt + [');
    expect(chordLabel('Alt+ArrowDown', false)).toBe('Alt + ↓');
  });
});

describe('割当の検め', () => {
  const base = defaultBindings();

  it('🔴 修飾の無い割当は断る(その面で字が打てなくなる)', () => {
    expect(validateBinding('create-entry', 'B', base)?.kind).toBe('bare');
    expect(validateBinding('create-entry', '1', base)?.kind).toBe('bare');
  });

  it('文字を打つ鍵でないものは修飾なしで許す(既定がそう作られている)', () => {
    // ⚠ ここを閉じると **自分の既定(Tab / Escape / F1)が自分の検査に落ちる**
    expect(validateBinding('row-commit', 'Tab', base)).toBeNull();
    /**
     * ⚠ **空いている鍵で試す** ── `F7` は 2026-08-19 に
     *   `dual-new-folder`(古典 4 実装が一致している割当)が取ったので、
     *   ここで使うと**衝突の検出が正しく働いた**ことを失敗として読むことになる。
     * ⚠ **`F9` も 2026-08-25 に埋まった**(`dual-preview`)── この test は
     *   「空いている鍵」を必要とするので、**埋まるたびに空いている鍵へ動かす**。
     *   🔑 落ちたら、まず**この行の鍵が誰かに取られていないか**を見ること
     *   (「検出が働いた」を「壊れた」と読まないため)。
     */
    expect(validateBinding('open-help', 'F10', base)).toBeNull();
  });

  it('🔴 コピー・貼り付けなどは横取りさせない', () => {
    expect(validateBinding('create-entry', 'Mod+C', base)?.kind).toBe('refused');
    expect(validateBinding('create-entry', 'Mod+V', base)?.kind).toBe('refused');
    expect(validateBinding('create-entry', 'Mod+W', base)?.kind).toBe('refused');
  });

  it('🔴 文脈が重なる相手とはぶつかる / 重ならない相手とはぶつからない', () => {
    // 全域どうし: ノートを作る に「編集する」の割当を当てるとぶつかる
    const clash = validateBinding('create-entry', 'Mod+E', base);
    expect(clash?.kind).toBe('conflict');
    expect(clash?.withCommandId).toBe('edit-entry');
    // 行の欄 と 2 列の編集欄 は同時に効かない ── `Escape` は両方の既定である
    expect(contextsOverlap(['row'], ['editor'])).toBe(false);
    expect(validateBinding('row-cancel', 'Escape', base)).toBeNull();
    // 全域は document で受けるので**全部と重なる**
    expect(contextsOverlap(['global'], ['row'])).toBe(true);
  });

  it('🔴 既定そのものが検めを通る(守れない条件を書いていない)', () => {
    // ⚠ CLAUDE.md §1「主張そのものが成り立たない」の予防 ──
    //    既定が自分の検査に落ちる状態を、機械で止める
    for (const cmd of KEY_COMMANDS) {
      expect(cmd.defaults.length, `${cmd.id} に既定が無い`).toBeGreaterThan(0);
      for (const chord of cmd.defaults) {
        const problem = validateBinding(cmd.id, chord, base);
        expect(problem, `${cmd.id} の既定 ${chord} が断られる: ${problem?.message ?? ''}`).toBeNull();
      }
    }
  });

  it('🔴 id は重複しない(設定画面に同じ行が 2 度出ない)', () => {
    const ids = KEY_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('上書きの解決', () => {
  it('知らない id と読めない割当は捨てる(古い保存で壊れない)', () => {
    const b = resolveBindings({ 'ghost-command': ['Mod+G'], 'create-entry': ['Mod+G', 42, 'Zzz+Q'] });
    expect(b['ghost-command']).toBeUndefined();
    expect(b['create-entry']).toEqual(['Mod+G']);
  });

  it('🔴 空配列は「割当なし」として尊重する(既定へ戻さない)', () => {
    const b = resolveBindings({ 'create-entry': [] });
    expect(b['create-entry']).toEqual([]);
    // ⚠ 触っていないものは既定のまま
    expect(b['open-help']).toEqual(findCommand('open-help')?.defaults);
  });

  it('壊れた保存でも既定が生きる', () => {
    const b = resolveBindings({});
    expect(b['create-entry']).toEqual(['Mod+N']);
  });
});

describe('打鍵 → コマンド', () => {
  const base = defaultBindings();
  const match = (e: ReturnType<typeof ev>, c: KeyContext) => matchCommand(chordOf(e), c, base);

  it('文脈ごとに引く', () => {
    expect(match(ev({ key: 'n', code: 'KeyN', ctrlKey: true }), 'global')).toBe('create-entry');
    // ⚠ 同じ打鍵でも面が違えば当たらない
    expect(match(ev({ key: 'n', code: 'KeyN', ctrlKey: true }), 'row')).toBeNull();
    expect(match(ev({ key: 'Tab', code: 'Tab' }), 'row')).toBe('row-commit');
    expect(match(ev({ key: 'Tab', code: 'Tab' }), 'editor')).toBeNull();
  });

  it('書式は 2 列の編集でも 1 面の行でも効く(同じ操作を 2 つの id にしない)', () => {
    const e = ev({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect(match(e, 'editor')).toBe('format-bold');
    expect(match(e, 'row')).toBe('format-bold');
  });

  it('別名(複数の割当)がどれも効く', () => {
    expect(match(ev({ key: 's', code: 'KeyS', metaKey: true }), 'editor')).toBe('commit-edit');
    expect(match(ev({ key: 'Enter', code: 'Enter', metaKey: true }), 'editor')).toBe('commit-edit');
  });

  it('🔴 上書きすると既定は当たらなくなる(足すだけの実装を許さない)', () => {
    const b = resolveBindings({ 'create-entry': ['Alt+M'] });
    expect(matchCommand(chordOf(ev({ key: 'm', code: 'KeyM', altKey: true })), 'global', b)).toBe(
      'create-entry',
    );
    expect(
      matchCommand(chordOf(ev({ key: 'n', code: 'KeyN', ctrlKey: true })), 'global', b),
      '既定が残っている(上書きが「足すだけ」になっている)',
    ).toBeNull();
  });
});

/**
 * 🔴 **わきの面(ノートを映さない面)は、鍵でも打鍵中に開ける**
 * (user 目線レビュー U-8、2026-08-22)。
 *
 * ⚠ 直す前は **4 つのうち 2 つ**(`open-flags` / `open-help`)しか名乗っておらず、
 *   **マウスでは 4 つとも開くのに、鍵では 2 つだけ**という非対称だった ──
 *   user 裁定 2026-08-08「ノートを映さない面は編集中でも開ける」は
 *   *面の側では*守られているのに、*鍵の側で*落ちていた。
 *
 * 🔑 **全数で見る** ── `isAsidePane` に面を足した人が、鍵の宣言を足し忘れたら
 *   ここが落ちる。⚠ 表は手で書くが、**`isAsidePane` の全数を覆っているか**も
 *   併せて検算する(表だけ書くと、面を足しても表に載らず素通りする)。
 *
 * ⚠ **名乗りは通行証ではない** ── 門は「名乗る **かつ** 和音が文字を打たない」の
 *   2 条件である。だから `Alt+3` / `Alt+6` は名乗っても通らない。それは仕様で
 *   あって欠陥ではない(本文に記号が入るのを防ぐ)ので、ここでは**宣言だけ**を見る。
 */
describe('🔴 わきの面の鍵(user 目線レビュー U-8)', () => {
  /** わきの面 → それを開くコマンド。⚠ 面を足したらここも足す。 */
  const ASIDE_COMMANDS: Record<string, string> = {
    settings: 'open-settings',
    flags: 'open-flags',
    help: 'open-help',
    dual: 'view-dual',
  };

  it('🔴 4 つとも whileTyping を名乗る(マウスと鍵で開ける面が食い違わない)', () => {
    for (const [pane, id] of Object.entries(ASIDE_COMMANDS)) {
      const cmd = findCommand(id);
      expect(cmd, `${id} というコマンドが無い(id を変えた?)`).toBeDefined();
      expect(cmd?.whileTyping, `${pane} は鍵では編集中に開けない(面の側とだけ食い違う)`).toBe(
        true,
      );
    }
  });

  it('⚠ 表が isAsidePane の全数を覆っている(面を足したら気づける)', () => {
    const ALL: readonly ViewMode[] = [
      'detail',
      'query',
      'dual',
      'settings',
      'flags',
      'help',
    ];
    const panes = ALL.filter((v) => isAsidePane(v));
    expect(
      [...panes].sort(),
      '上の表が古い ── わきの面が増減している',
    ).toEqual(Object.keys(ASIDE_COMMANDS).sort());
  });

  /**
   * ⚠ **対照群** ── ノートを並べる面(カレンダー等)は名乗らない。
   *   名乗らせると「編集中に押したら本文が消える」を鍵からも作ることになる。
   */
  it('⚠ ノートを映す面は名乗らない(編集していたものを画面から消さない)', () => {
    for (const id of ['view-calendar', 'view-kanban', 'view-query']) {
      const cmd = findCommand(id);
      if (!cmd) continue; // ⚠ 命令が無い面はここでは判定しない
      expect(cmd.whileTyping ?? false, `${id} が打鍵中に効くと、本文が消える`).toBe(false);
    }
  });
});
