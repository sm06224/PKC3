/** @vitest-environment happy-dom */
/**
 * 🔴 **アプリの一覧の「+ リンクを追加」は開閉式**(#1442 S3-2。user 指示 2026-11-24)。
 *
 * 直す前は名前・アドレス・追加の 3 行が常に一番上に出て、組み込みアプリの一覧が下へ押されていた。
 * 既定は**閉じて**一覧を最上段から見渡せる。開いたら最初の入力欄へ焦点 / 追加できたら閉じる /
 * Esc・キャンセルで閉じる / 閉じたらボタンへ焦点を戻す / 「操作を探す」の「リンクを追加」は閉じていれば開く。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { bindActions, runGlobalCommand } from '../../src/adapter/ui/actions/binder';
import { appKeymap } from '../../src/adapter/ui/render/keymap';
import { LauncherRenderer } from '../../src/adapter/ui/render/launcher';

beforeEach(() => {
  document.body.textContent = '';
});

function setup() {
  const root = document.createElement('div');
  root.setAttribute('data-pkc-slot', 'root');
  document.body.append(root);
  const region = document.createElement('div');
  root.append(region);
  const r = new LauncherRenderer(region);
  const d = new Dispatcher();
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
  d.dispatch({ type: 'LAUNCHER_TILES_LOADED', tiles: [] });
  r.render(d.getState());
  const q = <T extends HTMLElement>(f: string): T => region.querySelector<T>(`[data-pkc-field="${f}"]`)!;
  const form = (): HTMLElement => region.querySelector<HTMLElement>('[data-pkc-region="launcher-add"]')!;
  return { root, region, d, r, q, form };
}

const pressKey = (el: Element, key: string): boolean => {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
};

describe('「+ リンクを追加」の開閉', () => {
  it('🔴 既定は閉じている(欄は畳まれ、ボタンが aria-expanded=false で最上段にある)', () => {
    const { q, form, region } = setup();
    expect(form().hidden, '既定で開いている').toBe(true);
    expect(q('launcher-add-open').getAttribute('aria-expanded')).toBe('false');
    expect(q('launcher-add-open').textContent).toBe('+ リンクを追加');
    expect(q('launcher-add-open').getAttribute('aria-controls')).toBe(form().id);
    // 欄は一覧より前(最上段)に居る ── ボタン → 一覧の順で、開いても一覧を下へ押すだけ
    const wrap = region.firstElementChild!;
    expect(wrap.getAttribute('data-pkc-region')).toBe('launcher-add-wrap');
    expect(wrap.nextElementSibling?.getAttribute('data-pkc-field')).toBe('launcher-list');
  });

  it('🔴 押すと開き、最初の入力欄(名前)へ焦点が入る / もう一度押すと閉じて、焦点はボタンへ戻り、打った字は残る', () => {
    const { q, form } = setup();
    q('launcher-add-open').click();
    expect(form().hidden).toBe(false);
    expect(q('launcher-add-open').getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(q('launcher-add-name'));
    q<HTMLInputElement>('launcher-add-url').value = 'https://example.com';
    q('launcher-add-open').click();
    expect(form().hidden, 'もう一度押しても閉じない(片道)').toBe(true);
    expect(q('launcher-add-open').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(q('launcher-add-open'));
    expect(q<HTMLInputElement>('launcher-add-url').value, 'ボタンで畳んだだけで字が消えた').toBe('https://example.com');
  });

  it('🔴 Esc で閉じて(入力は空にして)焦点をボタンへ戻す。⚠ 背後の Esc へ流さない', () => {
    const { q, form, root } = setup();
    let leaked = 0;
    root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') leaked += 1;
    });
    q('launcher-add-open').click();
    q<HTMLInputElement>('launcher-add-url').value = 'https://example.com';
    pressKey(q('launcher-add-url'), 'Escape');
    expect(form().hidden, 'Esc で閉じない').toBe(true);
    expect(q<HTMLInputElement>('launcher-add-url').value, 'Esc で入力が残る').toBe('');
    expect(document.activeElement).toBe(q('launcher-add-open'));
    expect(leaked, 'Esc が背後へ流れた').toBe(0);
    // 対照群: 閉じている間の Esc は握らない
    pressKey(q('launcher-add-open'), 'Escape');
    expect(leaked, '閉じているのに Esc を握った').toBe(1);
  });

  it('🔴 キャンセルで入力を消して閉じる / 追加できたら閉じて欄を空にし、焦点をボタンへ戻す / 断られた回は開いたまま字を残す', () => {
    const { q, form, d } = setup();
    q('launcher-add-open').click();
    q<HTMLInputElement>('launcher-add-name').value = '地図';
    q<HTMLInputElement>('launcher-add-url').value = 'https://example.com/map';
    q('launcher-add-cancel').click();
    expect(form().hidden).toBe(true);
    expect(q<HTMLInputElement>('launcher-add-url').value).toBe('');
    expect(q<HTMLInputElement>('launcher-add-name').value).toBe('');
    expect(document.activeElement).toBe(q('launcher-add-open'));
    // 断られた回(開けない形)── 開いたまま・字も残る(対照群)
    q('launcher-add-open').click();
    q<HTMLInputElement>('launcher-add-url').value = 'javascript:alert(1)';
    q('launcher-add-go').click();
    expect(form().hidden, '断られたのに閉じた').toBe(false);
    expect(q<HTMLInputElement>('launcher-add-url').value, '断られたのに字が消えた').toBe('javascript:alert(1)');
    // 追加できた回
    q<HTMLInputElement>('launcher-add-url').value = 'https://example.com/map';
    q<HTMLInputElement>('launcher-add-name').value = '地図';
    q('launcher-add-go').click();
    expect(d.getState().entryMetas.size, '追加できていない').toBe(1);
    expect(form().hidden, '追加できたのに閉じない').toBe(true);
    expect(q<HTMLInputElement>('launcher-add-url').value).toBe('');
    expect(document.activeElement).toBe(q('launcher-add-open'));
  });

  it('🔴 「操作を探す」の「リンクを追加」は、閉じていれば開いてアドレスの欄へ移る(閉じた欄のボタンを黙って押さない)', () => {
    const { root, q, form, d } = setup();
    expect(form().hidden).toBe(true);
    // 一覧の「押せるか」── 閉じた欄の中でも効く(別のタブへ移って面ごと隠れているときは断る = 対照群は下)
    expect(runGlobalCommand('add-url-tile', root, d, appKeymap, () => {}, () => {}, true)).toBe(true);
    const said: string[] = [];
    runGlobalCommand('add-url-tile', root, d, appKeymap, () => {}, (t) => said.push(t), false);
    expect(form().hidden, '開いていない').toBe(false);
    expect(document.activeElement).toBe(q('launcher-add-url'));
    expect(said.join('')).toContain('「リンクを追加」');
    // 字が入った状態で閉じてあるときも、押さずに**開く**(見えない欄の字をそのまま送らない)
    q('launcher-add-open').click(); // 開いている → 閉じる(字は後から入れて、閉じたまま持たせる)
    expect(form().hidden).toBe(true);
    q<HTMLInputElement>('launcher-add-url').value = 'https://example.com';
    const before = d.getState().entryMetas.size;
    runGlobalCommand('add-url-tile', root, d, appKeymap, () => {}, () => {}, false);
    expect(form().hidden).toBe(false);
    expect(d.getState().entryMetas.size, '閉じた欄の字を黙って送った').toBe(before);
    // 対照群: 面ごと隠れている(別のタブ)ときは今までどおり「効かない」
    form().hidden = true;
    q('launcher-add-open').closest('[data-pkc-region="launcher-add-wrap"]')!.parentElement!.hidden = true;
    expect(runGlobalCommand('add-url-tile', root, d, appKeymap, () => {}, () => {}, true)).toBe(false);
  });
});
