/** @vitest-environment happy-dom */
/**
 * #1087: ショートカットキーの割り当て(保存・読み込み・検査)と、アプリのリンクを足す口。
 *
 * 守る主張:
 * 1. 設定ファイルの読み込み(`localStorage` へ直に書く)の後にキーを 1 つ割り当てても、読み込んだ割り当てが消えない
 * 2. 保存に書けない端末では、割り当てた直後に「保存できない」と言う(session 内では効く)
 * 3. 知らない id の割り当て(新しい版で付いた物)を、古い版が保存し直しても消さない
 * 4. 保存や設定ファイルから来た割り当ては、割り当てるときと同じ検査を通る(通らない物は使わず、保存には残す)
 * 5. 既に付いているキーをもう一度割り当てたら、そう言う
 * 6. アプリのリンクを足せなかったとき、「足しました」と言わず、欄の字を残す
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { phaseBlockReason } from '../../src/adapter/state/app-state';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { KeymapStore } from '../../src/adapter/ui/render/keymap';
import { buildKeymapPanel } from '../../src/adapter/ui/render/keymap-panel';
import { SETTINGS_NOT_PERSISTED_TEXT } from '../../src/adapter/ui/render/settings-persist-probe';
import { KEY_COMMANDS, REFUSED, resolveUsableBindings, validateBinding } from '../../src/features/keymap';
import { planSettingsImport, settingsPlanNote } from '../../src/features/settings/settings-file';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}
const KEY = 'pkc3.keymap';
const saved = (st: ReturnType<typeof fakeStorage>): Record<string, unknown> =>
  JSON.parse(st.map.get(KEY) ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  document.body.textContent = '';
});

describe('1. 設定ファイルの読み込みの後でも、割り当てが消えない', () => {
  it('🔴 読み込み(保存へ直に書く)→ キーを 1 つ割り当て → 読み込んだ分も残る', () => {
    const st = fakeStorage();
    const s = new KeymapStore(st);
    expect(s.getBindings()['edit-entry']).toEqual(['Mod+E']); // 1 度読ませる(憶えを作る)
    // 設定ファイルの「当てる」は localStorage へ直に書く(憶えは古いまま)
    st.map.set(KEY, JSON.stringify({ 'edit-entry': ['Mod+E', 'Alt+9'] }));
    expect(s.addBinding('create-entry', 'Alt+M')).toBeNull();
    expect(saved(st)['edit-entry'], '読み込んだ割り当てが保存から消えた').toEqual(['Mod+E', 'Alt+9']);
    expect(s.getBindings()['edit-entry'], '画面の割り当てにも出ていない').toEqual(['Mod+E', 'Alt+9']);
    expect(s.getBindings()['create-entry']).toEqual(['Alt+N', 'Alt+M']);
  });

  it('戻す前にも読み直す', () => {
    const st = fakeStorage();
    const s = new KeymapStore(st);
    s.getBindings();
    st.map.set(KEY, JSON.stringify({ 'edit-entry': ['Alt+9'], 'create-entry': ['Alt+M'] }));
    s.resetCommand('create-entry');
    expect(saved(st)).toEqual({ 'edit-entry': ['Alt+9'] });
  });

  it('外す前にも読み直す', () => {
    const st = fakeStorage();
    const s = new KeymapStore(st);
    s.getBindings();
    st.map.set(KEY, JSON.stringify({ 'edit-entry': ['Alt+9'] }));
    s.removeBinding('create-entry', 'Alt+N');
    expect(saved(st)).toEqual({ 'edit-entry': ['Alt+9'], 'create-entry': [] });
  });
});

describe('2. 保存に書けない端末', () => {
  const dead = () => ({
    getItem: () => null,
    setItem: () => {
      throw new Error('private mode');
    },
    removeItem: () => {
      throw new Error('private mode');
    },
  });

  it('🔴 割り当てた直後に、保存できないと言う(この session では効く)', () => {
    const s = new KeymapStore(dead());
    const p = s.addBinding('create-entry', 'Alt+M');
    expect(p?.kind).toBe('unsaved');
    expect(p?.message).toBe(SETTINGS_NOT_PERSISTED_TEXT);
    expect(s.getBindings()['create-entry']).toEqual(['Alt+N', 'Alt+M']);
  });

  it('保存の入れ物が無い(null)ときも同じ', () => {
    const s = new KeymapStore(null);
    expect(s.addBinding('create-entry', 'Alt+M')?.kind).toBe('unsaved');
    expect(s.getBindings()['create-entry']).toEqual(['Alt+N', 'Alt+M']);
  });

  it('書けなかった割り当ては、次の操作で読み直した空の保存に消されない', () => {
    const s = new KeymapStore(dead());
    s.addBinding('create-entry', 'Alt+M');
    s.addBinding('edit-entry', 'Alt+9');
    expect(s.getBindings()['create-entry']).toEqual(['Alt+N', 'Alt+M']);
  });

  it('画面の注: 割り当てた + 保存できない、の言い方になる(「割り当てられません」ではない)', () => {
    const s = new KeymapStore(dead());
    const panel = buildKeymapPanel(s, document);
    document.body.append(panel.root);
    panel.root
      .querySelector<HTMLButtonElement>('[data-pkc-field="keymap-assign"][data-pkc-command="create-entry"]')!
      .click();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, bubbles: true, cancelable: true }),
    );
    const note = panel.root.querySelector(
      '[data-pkc-field="keymap-row"][data-pkc-command="create-entry"] [data-pkc-field="settings-note"]',
    )!;
    expect(note.textContent).toContain('割り当てました');
    expect(note.textContent).toContain(SETTINGS_NOT_PERSISTED_TEXT);
    expect(note.textContent).not.toContain('割り当てられません');
    panel.dispose();
  });
});

describe('2b. 外す・既定に戻すも、保存できなかったことを言う', () => {
  const dead = () => ({
    getItem: () => null,
    setItem: () => {
      throw new Error('private mode');
    },
    removeItem: () => {
      throw new Error('private mode');
    },
  });
  const noteOf = (root: Element, id: string) =>
    root.querySelector(`[data-pkc-field="keymap-row"][data-pkc-command="${id}"] [data-pkc-field="settings-note"]`)!;

  it('🔴 store は保存できたかを返す(書ける端末では true)', () => {
    expect(new KeymapStore(fakeStorage()).removeBinding('create-entry', 'Alt+N')).toBe(true);
    const ok = new KeymapStore(fakeStorage());
    ok.addBinding('create-entry', 'Alt+M');
    expect(ok.resetCommand('create-entry')).toBe(true);
    expect(ok.resetAll()).toBe(true);
    const s = new KeymapStore(dead());
    expect(s.removeBinding('create-entry', 'Alt+N')).toBe(false);
    s.addBinding('edit-entry', 'Alt+9');
    expect(s.resetCommand('edit-entry')).toBe(false);
    expect(s.resetAll()).toBe(false);
  });

  it('🔴 × で外す / 既定に戻す / すべて既定に戻す、の 3 つとも画面に出る(書ける端末では出ない)', async () => {
    for (const [storage, expectNote] of [
      [dead(), true],
      [fakeStorage(), false],
    ] as const) {
      document.body.textContent = '';
      const s = new KeymapStore(storage);
      const panel = buildKeymapPanel(s, document);
      document.body.append(panel.root);
      const root = panel.root;
      root
        .querySelector<HTMLButtonElement>(
          '[data-pkc-field="keymap-drop"][data-pkc-command="create-entry"][data-pkc-chord="Alt+N"]',
        )!
        .click();
      const dropNote = noteOf(root, 'create-entry').textContent ?? '';
      expect(dropNote.includes(SETTINGS_NOT_PERSISTED_TEXT), `× の注: ${dropNote}`).toBe(expectNote);
      if (expectNote) expect(dropNote).toContain('を外しました');
      root.querySelector<HTMLButtonElement>('[data-pkc-field="keymap-reset"][data-pkc-command="create-entry"]')!.click();
      const resetNote = noteOf(root, 'create-entry').textContent ?? '';
      expect(resetNote.includes(SETTINGS_NOT_PERSISTED_TEXT), `既定に戻す の注: ${resetNote}`).toBe(expectNote);
      // ⚠ 全部が既定のままだと押せない(押せないボタンの click は何も起こさない)── 1 つ割り当ててから押す
      s.addBinding('edit-entry', 'Alt+9');
      const all = root.querySelector<HTMLButtonElement>('[data-pkc-field="keymap-reset-all"]')!;
      expect(all.disabled).toBe(false);
      all.click();
      await new Promise((r) => setTimeout(r, 0));
      document.querySelector<HTMLButtonElement>('[data-pkc-field="dialog-ok"]')!.click();
      await new Promise((r) => setTimeout(r, 0));
      const allNote = root.querySelector('[data-pkc-field="keymap-reset-all-note"]')!.textContent ?? '';
      expect(allNote.includes(SETTINGS_NOT_PERSISTED_TEXT), `すべて既定に戻す の注: ${allNote}`).toBe(expectNote);
      panel.dispose();
    }
  });
});

describe('3. 知らない id の割り当ては触らずに残す', () => {
  it('🔴 古い版でキーを 1 つ変えても、新しい版の割り当てが保存から消えない', () => {
    const st = fakeStorage();
    st.map.set(KEY, JSON.stringify({ 'future-command': ['Alt+Q'], 'create-entry': ['Alt+N'] }));
    const s = new KeymapStore(st);
    expect(s.addBinding('edit-entry', 'Alt+9')).toBeNull();
    expect(saved(st)['future-command']).toEqual(['Alt+Q']);
    s.removeBinding('edit-entry', 'Alt+9');
    expect(saved(st)['future-command']).toEqual(['Alt+Q']);
    s.resetAll();
    expect(saved(st)).toEqual({ 'future-command': ['Alt+Q'] });
  });

  it('知らない id だけが残っていても、画面は「変えていない」(すべて既定に戻すは押せない)', () => {
    const st = fakeStorage();
    st.map.set(KEY, JSON.stringify({ 'future-command': ['Alt+Q'] }));
    const s = new KeymapStore(st);
    expect(Object.keys(s.getOverrides())).toEqual([]);
    const panel = buildKeymapPanel(s, document);
    expect(panel.root.querySelector<HTMLButtonElement>('[data-pkc-field="keymap-reset-all"]')!.disabled).toBe(true);
  });

  it('知らない id は使わない', () => {
    const st = fakeStorage();
    st.map.set(KEY, JSON.stringify({ 'future-command': ['Alt+Q'] }));
    const s = new KeymapStore(st);
    expect(Object.keys(s.getBindings())).not.toContain('future-command');
  });
});

describe('4. 再読み込みの鍵は割り当てられない', () => {
  it.each(['Mod+Shift+R', 'F5', 'Mod+F5', 'Shift+F5', 'Mod+R'])('%s は断る', (chord) => {
    expect(REFUSED).toContain(chord);
    const p = validateBinding('create-entry', chord, {});
    expect(p?.kind).toBe('refused');
    expect(p?.message).toContain('再読込');
  });

  it('そのコマンド自身の既定は断らない(2 ペインの「反対側へコピー」の既定は F5)', () => {
    expect(KEY_COMMANDS.find((c) => c.id === 'dual-copy-to-other')?.defaults, '前提が崩れた').toContain('F5');
    expect(validateBinding('dual-copy-to-other', 'F5', {})).toBeNull();
    expect(validateBinding('create-entry', 'F5', {})?.kind, '他のコマンドへは断る').toBe('refused');
  });

  it('F11(全画面)は奪われても戻し道が在るので、割り当てられる(判断)', () => {
    expect(validateBinding('create-entry', 'F11', {})).toBeNull();
  });
});

describe('5. 保存や設定ファイルの割り当ても、割り当てるときと同じ検査を通る', () => {
  const orderOf = (id: string): number => KEY_COMMANDS.findIndex((c) => c.id === id);

  it('🔴 素の B・Ctrl+R・F5 は使わない(保存には残す)', () => {
    const st = fakeStorage();
    st.map.set(KEY, JSON.stringify({ 'create-entry': ['Alt+N', 'B', 'Mod+R', 'F5', 'Alt+M'] }));
    const s = new KeymapStore(st);
    expect(s.getBindings()['create-entry']).toEqual(['Alt+N', 'Alt+M']);
    expect(s.getUnusable().map((u) => u.chord).sort()).toEqual(['B', 'F5', 'Mod+R']);
    expect(
      s.match({ key: 'b', code: 'KeyB', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, 'global'),
    ).toBeNull();
    // 消さない ── 後で直せる
    expect(saved(st)['create-entry']).toEqual(['Alt+N', 'B', 'Mod+R', 'F5', 'Alt+M']);
  });

  it('🔴 同じ鍵の 2 件目は黙って死なず、使えない物として数える(表の先が勝つ)', () => {
    const [first, second] =
      orderOf('create-entry') < orderOf('edit-entry') ? ['create-entry', 'edit-entry'] : ['edit-entry', 'create-entry'];
    const r = resolveUsableBindings({ [first!]: ['Alt+M'], [second!]: ['Alt+M'] });
    expect(r.bindings[first!]).toContain('Alt+M');
    expect(r.bindings[second!]).not.toContain('Alt+M');
    expect(r.unusable.map((u) => `${u.commandId}:${u.chord}`)).toEqual([`${second!}:Alt+M`]);
    expect(r.unusable[0]?.problem.kind).toBe('conflict');
  });

  it('そのコマンド自身の既定を書き直しただけの上書きは、全部使える', () => {
    const r = resolveUsableBindings({ 'create-entry': ['Alt+N'] });
    expect(r.unusable).toEqual([]);
    expect(r.bindings['create-entry']).toEqual(['Alt+N']);
  });

  it('使えない割り当てが在るコマンドに使える鍵を足しても、使えない物を保存から消さない', () => {
    const st = fakeStorage();
    st.map.set(KEY, JSON.stringify({ 'create-entry': ['Alt+N', 'B'] }));
    const s = new KeymapStore(st);
    expect(s.addBinding('create-entry', 'Alt+M')).toBeNull();
    expect(saved(st)['create-entry']).toEqual(['Alt+N', 'B', 'Alt+M']);
  });

  it('設定ファイルの読み込みの下見に「使えない割り当て N 件」が出る', () => {
    const file = (value: unknown): string =>
      JSON.stringify({
        kind: 'pkc3-settings',
        version: 1,
        entries: [{ key: KEY, value: JSON.stringify(value) }],
      });
    const plan = planSettingsImport(file({ 'create-entry': ['Alt+N', 'B', 'Mod+R'] }), () => null);
    expect(plan.changes).toHaveLength(1); // 前提: 割り当ては入る
    expect(plan.unusableBindings).toBe(2);
    expect(settingsPlanNote(plan)).toContain('2 件は');
    expect(settingsPlanNote(plan)).toContain('使われません');
    const clean = planSettingsImport(file({ 'create-entry': ['Alt+N', 'Alt+M'] }), () => null);
    expect(clean.changes).toHaveLength(1);
    expect(clean.unusableBindings).toBe(0);
    expect(settingsPlanNote(clean)).not.toContain('使われません');
  });

  it('🔴 素の Tab / Shift+Tab を既定に持たない操作へ付けた割り当ては、使われない物として数える(#1087)', () => {
    const file = (value: unknown): string =>
      JSON.stringify({
        kind: 'pkc3-settings',
        version: 1,
        entries: [{ key: KEY, value: JSON.stringify(value) }],
      });
    const plan = planSettingsImport(file({ 'create-entry': ['Alt+N', 'Tab', 'Shift+Tab'] }), () => null);
    expect(plan.unusableBindings).toBe(2);
    expect(settingsPlanNote(plan)).toContain('使われません');
    const usable = resolveUsableBindings({ 'create-entry': ['Alt+N', 'Tab'] });
    expect(usable.bindings['create-entry']).toEqual(['Alt+N']);
    // 対照: 既定に Tab を持つ操作は、Tab を持ったまま
    expect(resolveUsableBindings({ 'row-commit': ['Tab', 'Mod+Enter'] }).unusable).toEqual([]);
  });
});

describe('6. 既に付いているキーをもう一度割り当てる', () => {
  it('🔴 「もう割り当ててあります」と返し、保存は動かさない', () => {
    const st = fakeStorage();
    const s = new KeymapStore(st);
    const p = s.addBinding('create-entry', 'Alt+N');
    expect(p?.kind).toBe('duplicate');
    expect(p?.message).toBe('もう割り当ててあります');
    expect(st.map.size).toBe(0);
    s.addBinding('create-entry', 'Alt+M');
    expect(s.addBinding('create-entry', 'Alt+M')?.kind).toBe('duplicate');
    expect(s.getBindings()['create-entry']).toEqual(['Alt+N', 'Alt+M']);
  });

  it('画面の注に出る(「割り当てられません」ではなく、付いている旨)', () => {
    const s = new KeymapStore(fakeStorage());
    const panel = buildKeymapPanel(s, document);
    document.body.append(panel.root);
    panel.root
      .querySelector<HTMLButtonElement>('[data-pkc-field="keymap-assign"][data-pkc-command="create-entry"]')!
      .click();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', altKey: true, bubbles: true, cancelable: true }),
    );
    const note = panel.root.querySelector(
      '[data-pkc-field="keymap-row"][data-pkc-command="create-entry"] [data-pkc-field="settings-note"]',
    )!;
    expect(note.textContent).toContain('もう割り当ててあります');
    expect(note.textContent).not.toContain('割り当てられません');
    panel.dispose();
  });
});

describe('7. アプリのリンクを足す口', () => {
  function setup() {
    const root = document.createElement('div');
    root.setAttribute('data-pkc-slot', 'root');
    root.innerHTML =
      '<input data-pkc-field="launcher-add-name"><input data-pkc-field="launcher-add-url"><button data-pkc-action="add-url-tile"></button>';
    document.body.append(root);
    const d = new Dispatcher();
    const statuses: string[] = [];
    bindActions(root, d, { showStatus: (t: string) => void statuses.push(t) }, new KeymapStore(fakeStorage()));
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    const name = root.querySelector<HTMLInputElement>('[data-pkc-field="launcher-add-name"]')!;
    const url = root.querySelector<HTMLInputElement>('[data-pkc-field="launcher-add-url"]')!;
    name.value = 'サイト';
    url.value = 'https://example.com/';
    const press = (): void => root.querySelector<HTMLButtonElement>('[data-pkc-action="add-url-tile"]')!.click();
    return { d, statuses, name, url, press };
  }

  it('対照: 作れるときは足して、欄を空にして、足したと言う', () => {
    const s = setup();
    s.press();
    expect(s.d.getState().entryMetas.size).toBe(1);
    expect(s.statuses).toEqual(['「サイト」を足しました']);
    expect(s.url.value).toBe('');
  });

  it('🔴 編集中は足せない ── 理由を言い、「足しました」と言わず、欄の字を残す', () => {
    const s = setup();
    s.d.dispatch({ type: 'CREATE_ENTRY', lid: 'x', archetype: 'text', title: 'メモ' });
    expect(s.d.getState().phase, '前提が崩れた(編集に入れていない)').toBe('editing');
    const before = s.d.getState().entryMetas.size;
    s.press();
    expect(s.d.getState().entryMetas.size, '編集中に作れてしまった').toBe(before);
    expect(s.statuses, '作っていないのに足したと言った').toEqual([]);
    expect(s.d.getState().error).toBe(`${phaseBlockReason('editing')}足してください`);
    expect(s.url.value).toBe('https://example.com/');
    expect(s.name.value).toBe('サイト');
  });

  it('🔴 受け付ける状態でも作れなかった回は、足したと言わず欄を残す(作れたかを見ている)', () => {
    const s = setup();
    const orig = s.d.dispatch.bind(s.d);
    // reducer が断った回を模す(lid の衝突など)── CREATE_ENTRY だけ捨てる
    s.d.dispatch = ((a: Parameters<Dispatcher['dispatch']>[0]) =>
      a.type === 'CREATE_ENTRY' ? undefined : orig(a)) as Dispatcher['dispatch'];
    s.press();
    expect(s.statuses).toEqual([]);
    expect(s.url.value).toBe('https://example.com/');
  });
});
