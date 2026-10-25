/** @vitest-environment happy-dom */
/**
 * 🔴 Office のメニューが開いている間、打った字をメニューへ届ける(#1360)。
 *
 * 実害: Mac の右クリックのメニューで `Y`(コピー(Y))が効かない / 日本語入力オンだと選択範囲が「ｙ」に置き換わる。
 * 原因: Qt は IME 用の隠し `<input>` が受けた **修飾キーなしの 1 文字キーをキーイベントにしない**
 * (`QWasmWindow::handleKeyForInputContextEvent`)。LO のメニューはキーイベントで鍵を探すので、字は文書へ入る。
 *
 * ⚠ `public/office/office-popup-keys.js` は **bundle されない素の JS**(`host.html` が `<script src>` で読む)。
 *   `readFileSync` + `new Function` で読み込んで判断と配線を直に当てる。
 *   実ブラウザ + 実 LO での前後は `build/office-wasm/ime-compose-probe.mjs` の `ctx-kbd` / `ctx-kbd-ime` 腕。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

interface KeyLike {
  key?: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}
type Decision = { kind: 'pass' } | { kind: 'route'; key: string; ime: boolean };
interface Installed {
  uninstall(): void;
  state(): { swallowing: boolean; routed: string[] };
}
interface Api {
  keyFromCode(code: string, shiftKey: boolean): string | null;
  isFramelessWindowClass(cls: string): boolean;
  decide(ev: KeyLike, ctx: { popupOpen: boolean; onImeInput: boolean }): Decision;
  syntheticInit(ev: KeyLike, key: string): Record<string, unknown>;
  findPopupCanvases(doc: Document): HTMLCanvasElement[];
  install(win: Window, env?: { doc?: Document }): Installed;
}

function load(): Api {
  const src = readFileSync('public/office/office-popup-keys.js', 'utf-8');
  const scope: Record<string, unknown> = {};
  new Function('globalThis', 'window', src)(scope, undefined);
  const api = scope.PkcOfficePopupKeys as Api | undefined;
  expect(api, '素の JS が globalThis へ何も置いていない').toBeTruthy();
  return api!;
}
const api = load();

const OPEN = { popupOpen: true, onImeInput: true };

describe('キー 1 つをどうするか(decide)', () => {
  it('🔴 メニューが開いていて、IME 用 <input> が受けた字は、メニューへ回す', () => {
    expect(api.decide({ key: 'y', code: 'KeyY', keyCode: 89 }, OPEN)).toEqual({ kind: 'route', key: 'y', ime: false });
  });

  it('🔴 日本語入力オン(keyCode 229 / key=Process)でも、code から字を決めて回す', () => {
    expect(api.decide({ key: 'Process', code: 'KeyY', keyCode: 229 }, OPEN)).toEqual({ kind: 'route', key: 'y', ime: true });
    expect(api.decide({ key: 'y', code: 'KeyY', keyCode: 229 }, OPEN)).toEqual({ kind: 'route', key: 'y', ime: true });
    expect(api.decide({ key: 'Process', code: 'KeyY', keyCode: 229, shiftKey: true }, OPEN)).toEqual({
      kind: 'route',
      key: 'Y',
      ime: true,
    });
  });

  it('⚠ 回さない: メニューが閉じている / <input> 以外の宛先(= ふつうの打鍵・ダイアログの入力欄を壊さない)', () => {
    expect(api.decide({ key: 'y', code: 'KeyY' }, { popupOpen: false, onImeInput: true })).toEqual({ kind: 'pass' });
    expect(api.decide({ key: 'y', code: 'KeyY' }, { popupOpen: true, onImeInput: false })).toEqual({ kind: 'pass' });
  });

  it('⚠ 回さない: 修飾キーつき(Qt が元からキーイベントにする。AltGr の字も壊さない)/ 変換の途中 / 1 文字でないキー', () => {
    for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const)
      expect(api.decide({ key: 'c', code: 'KeyC', [mod]: true }, OPEN)).toEqual({ kind: 'pass' });
    expect(api.decide({ key: 'ｙ', code: 'KeyY', isComposing: true }, OPEN)).toEqual({ kind: 'pass' });
    for (const key of ['Enter', 'ArrowDown', 'Escape', 'Shift', 'Backspace'])
      expect(api.decide({ key, code: key }, OPEN), key).toEqual({ kind: 'pass' });
  });

  it('⚠ 処理済みキーで字が決められないもの(記号になる Shift+数字 / 英数でない物理キー)は回さない', () => {
    expect(api.decide({ key: 'Process', code: 'Digit1', keyCode: 229, shiftKey: true }, OPEN)).toEqual({ kind: 'pass' });
    expect(api.decide({ key: 'Process', code: 'Space', keyCode: 229 }, OPEN)).toEqual({ kind: 'pass' });
    expect(api.keyFromCode('Digit1', false)).toBe('1');
    expect(api.keyFromCode('KeyZ', false)).toBe('z');
    expect(api.keyFromCode('', false)).toBeNull();
  });

  it('合成するキーイベントは Qt が読む key / code / repeat を持ち、修飾キーは Shift だけ', () => {
    const init = api.syntheticInit({ code: 'KeyY', shiftKey: false, repeat: true, ctrlKey: true }, 'y');
    expect(init).toMatchObject({ key: 'y', code: 'KeyY', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: true });
    expect(init.bubbles).toBe(true);
  });
});

describe('メニュー(枠のない窓)の見分け', () => {
  it('🔑 枠のない窓だけがメニュー。本体・ダイアログ(has-title)は数えない', () => {
    expect(api.isFramelessWindowClass('qt-decorated-window')).toBe(true);
    expect(api.isFramelessWindowClass('qt-decorated-window has-border has-shadow has-title')).toBe(false);
    expect(api.isFramelessWindowClass('something-else')).toBe(false);
    expect(api.isFramelessWindowClass('')).toBe(false);
  });
});

/** Qt が組む DOM を真似る: #screen > host(shadowRoot) > 窓 > canvas。 */
function qtDom(opts: { popup: boolean }) {
  document.body.innerHTML = '<div id="screen"><div id="qt-shadow-container"></div></div>';
  const root = document.getElementById('qt-shadow-container')!.attachShadow({ mode: 'open' });
  const mk = (cls: string, display = 'block') => {
    const w = document.createElement('div');
    w.className = cls;
    w.style.display = display;
    const c = document.createElement('canvas');
    w.appendChild(c);
    root.appendChild(w);
    return c;
  };
  const main = mk('qt-decorated-window has-border has-shadow has-title');
  const popup = opts.popup ? mk('qt-decorated-window') : null;
  const input = document.createElement('input');
  (input as unknown as Record<string, unknown>)['data-qinputcontext'] = 12345;
  document.body.appendChild(input);
  return { main, popup, input };
}

const seen: string[] = [];
function listen(el: EventTarget, label: string, types: string[]) {
  for (const t of types)
    el.addEventListener(t, (e) => {
      seen.push(`${label}:${t}:${(e as KeyboardEvent).key ?? (e as InputEvent).data ?? ''}`);
    });
}
function keyEvent(type: string, init: KeyboardEventInit & { keyCode?: number }) {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: init.keyCode });
  return e;
}

let installed: Installed | null = null;
afterEach(() => {
  installed?.uninstall();
  installed = null;
  seen.length = 0;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('配線(install)', () => {
  it('🔴 メニューが開いているとき: <input> の Y は文書へ入らず、メニューの canvas へキーイベントとして届く', () => {
    const { popup, input } = qtDom({ popup: true });
    expect(api.findPopupCanvases(document)).toHaveLength(1);
    installed = api.install(window);
    listen(popup!, 'popup', ['keydown', 'keyup']);
    listen(input, 'input', ['keydown', 'keyup']);
    const down = keyEvent('keydown', { key: 'y', code: 'KeyY', keyCode: 89 });
    input.dispatchEvent(down);
    expect(seen, 'Qt の <input> の listener まで届いた = 文書へ入る道が残っている').toEqual(['popup:keydown:y']);
    expect(down.defaultPrevented, 'input イベント(文書への挿入)を止めていない').toBe(true);
    input.dispatchEvent(keyEvent('keyup', { key: 'y', code: 'KeyY', keyCode: 89 }));
    expect(seen).toEqual(['popup:keydown:y', 'popup:keyup:y']);
  });

  it('🔴 メニューが無いとき: 何も奪わない(ふつうの打鍵は <input> へ届く / 合成もしない)', () => {
    const { main, input } = qtDom({ popup: false });
    installed = api.install(window);
    listen(main, 'main', ['keydown']);
    listen(input, 'input', ['keydown']);
    const down = keyEvent('keydown', { key: 'y', code: 'KeyY', keyCode: 89 });
    input.dispatchEvent(down);
    expect(seen).toEqual(['input:keydown:y']);
    expect(down.defaultPrevented).toBe(false);
  });

  it('⚠ 修飾キーつき(Ctrl+C)・矢印は、メニューが開いていても素通り', () => {
    const { popup, input } = qtDom({ popup: true });
    installed = api.install(window);
    listen(popup!, 'popup', ['keydown']);
    listen(input, 'input', ['keydown']);
    input.dispatchEvent(keyEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true }));
    input.dispatchEvent(keyEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown' }));
    expect(seen).toEqual(['input:keydown:c', 'input:keydown:ArrowDown']);
  });

  it('⚠ 他の入力欄(Qt の IME 用でない <input>)の打鍵は奪わない', () => {
    const { popup } = qtDom({ popup: true });
    const other = document.createElement('input');
    document.body.appendChild(other);
    installed = api.install(window);
    listen(popup!, 'popup', ['keydown']);
    listen(other, 'other', ['keydown']);
    other.dispatchEvent(keyEvent('keydown', { key: 'y', code: 'KeyY' }));
    expect(seen).toEqual(['other:keydown:y']);
  });

  it('🔴 日本語入力オン: 処理済みキーの Y をメニューへ回し、始まった変換は Qt へ流さず捨てる(文書を置き換えさせない)', () => {
    vi.useFakeTimers();
    const { popup, input } = qtDom({ popup: true });
    installed = api.install(window);
    listen(popup!, 'popup', ['keydown']);
    listen(input, 'input', ['keydown', 'compositionstart', 'compositionupdate', 'input', 'compositionend']);
    const blur = vi.spyOn(input, 'blur');
    const focus = vi.spyOn(input, 'focus');
    input.dispatchEvent(keyEvent('keydown', { key: 'Process', code: 'KeyY', keyCode: 229 }));
    expect(seen).toEqual(['popup:keydown:y']);
    expect(installed.state().swallowing).toBe(true);
    // 続けて変換が始まる(Qt はこれを受けると preedit を文書へ入れる)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }));
    input.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, composed: true, data: 'ｙ' }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: 'ｙ', inputType: 'insertCompositionText' }));
    expect(seen, 'Qt の listener へ変換が流れた = 選択範囲が「ｙ」に置き換わる').toEqual(['popup:keydown:y']);
    vi.advanceTimersByTime(10); // blur → focus の 0ms の timer だけ(握り潰しの 1.5 秒の timer は進めない)
    expect(blur, '変換を捨てる blur が無い').toHaveBeenCalled();
    expect(focus, 'blur の後に焦点を戻していない(IME 用 <input> が死ぬ)').toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: 'ｙ' }));
    expect(installed.state().swallowing, '変換が終わっても握り潰しが残る').toBe(false);
    // その後の変換は通る(次の打鍵から日本語が打てる)
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true, data: '' }));
    expect(seen).toEqual(['popup:keydown:y', 'input:compositionstart:']); // compositionend は握り潰された
  });

  it('⚠ 握り潰しは時間で解ける(変換が終わらなくても、日本語入力が一生死なない)', () => {
    vi.useFakeTimers();
    const { input } = qtDom({ popup: true });
    installed = api.install(window);
    input.dispatchEvent(keyEvent('keydown', { key: 'Process', code: 'KeyY', keyCode: 229 }));
    expect(installed.state().swallowing).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(installed.state().swallowing).toBe(false);
  });

  it('uninstall で外れる', () => {
    const { popup, input } = qtDom({ popup: true });
    installed = api.install(window);
    installed.uninstall();
    installed = null;
    listen(popup!, 'popup', ['keydown']);
    listen(input, 'input', ['keydown']);
    input.dispatchEvent(keyEvent('keydown', { key: 'y', code: 'KeyY' }));
    expect(seen).toEqual(['input:keydown:y']);
  });
});

describe('host.html の配線(#1360)', () => {
  const host = readFileSync('public/office/host.html', 'utf-8');

  it('🔴 script を読み、window へ install している(読むだけで install しない配線漏れを防ぐ)', () => {
    expect(host).toContain('<script src="office-popup-keys.js"></script>');
    expect(host).toContain('window.PkcOfficePopupKeys.install(window)');
    expect(host.indexOf('office-popup-keys.js'), 'install より後に読んでいる').toBeLessThan(host.indexOf('PkcOfficePopupKeys.install'));
  });
});
