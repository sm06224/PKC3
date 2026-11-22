/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTipTitle, installTooltip, setTipTitle, TIP_ID, TIP_STASH_ATTR } from '@adapter/ui/render/tooltip';

let off: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button id="a" title="保存する">A</button><button id="b" title="開く" aria-label="開く">B</button><div id="p"><span id="c">c</span></div>';
  off = installTooltip(document, { delayMs: 400 });
});
afterEach(() => {
  off();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const ev = (type: string, target: Element, init: Record<string, unknown> = {}): void => {
  const e = new Event(type, { bubbles: true });
  Object.assign(e, { pointerType: 'mouse', clientX: 10, clientY: 10, ...init });
  target.dispatchEvent(e);
};
const a = (): HTMLElement => document.getElementById('a')!;
const tip = (): HTMLElement | null => document.getElementById(TIP_ID);

describe('tooltip', () => {
  it('載せている間だけ title を退避し、離れたら戻す', () => {
    ev('pointerover', a());
    expect(a().hasAttribute('title')).toBe(false);
    expect(a().getAttribute(TIP_STASH_ATTR)).toBe('保存する');
    ev('pointerout', a(), { relatedTarget: document.body });
    expect(a().getAttribute('title')).toBe('保存する');
    expect(a().hasAttribute(TIP_STASH_ATTR)).toBe(false);
  });
  it('400ms 後に出る。それまでは出ない', () => {
    ev('pointerover', a());
    vi.advanceTimersByTime(399);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(2);
    expect(tip()!.hidden).toBe(false);
    expect(tip()!.textContent).toBe('保存する');
  });
  it('aria-describedby は aria-label が無い要素にだけ、出している間だけ', () => {
    const b = document.getElementById('b')!;
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    expect(a().getAttribute('aria-describedby')).toBe(TIP_ID);
    ev('pointerout', a(), { relatedTarget: document.body });
    expect(a().hasAttribute('aria-describedby')).toBe(false);
    ev('pointerover', b);
    vi.advanceTimersByTime(500);
    expect(b.hasAttribute('aria-describedby')).toBe(false);
    expect(b.getAttribute('aria-label')).toBe('開く');
  });
  it('離れる・押す・Esc・スクロールで即消える', () => {
    const cases: Array<() => void> = [
      () => ev('pointerout', a(), { relatedTarget: document.body }),
      () => ev('pointerdown', a()),
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      () => document.dispatchEvent(new Event('scroll')),
      () => ev('focusout', a()),
      () => window.dispatchEvent(new Event('blur')),
    ];
    for (const c of cases) {
      ev('pointerover', a());
      vi.advanceTimersByTime(500);
      expect(tip()!.hidden).toBe(false);
      c();
      expect(tip()!.hidden).toBe(true);
      expect(a().getAttribute('title')).toBe('保存する');
    }
  });
  it('タッチでは出さず title も動かさない', () => {
    ev('pointerover', a(), { pointerType: 'touch' });
    vi.advanceTimersByTime(500);
    expect(tip()).toBeNull();
    expect(a().getAttribute('title')).toBe('保存する');
  });
  it('子要素へ動いても(対象の内側)消えない', () => {
    const p = document.getElementById('p')!;
    p.setAttribute('title', '親');
    ev('pointerover', document.getElementById('c')!);
    vi.advanceTimersByTime(500);
    ev('pointerout', document.getElementById('c')!, { relatedTarget: p });
    expect(tip()!.hidden).toBe(false);
  });
  it('対象が消えたら隠す', async () => {
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    a().remove();
    await Promise.resolve();
    expect(tip()!.hidden).toBe(true);
  });
  it('出す前に対象が消えても出ない', async () => {
    ev('pointerover', a());
    a().remove();
    vi.advanceTimersByTime(500);
    expect(tip() === null || tip()!.hidden).toBe(true);
  });
  it('載せている間に title が書き直されたら新しい方を残す', () => {
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    a().setAttribute('title', '新しい');
    ev('pointerout', a(), { relatedTarget: document.body });
    expect(a().getAttribute('title')).toBe('新しい');
    expect(a().hasAttribute(TIP_STASH_ATTR)).toBe(false);
  });
  it('キーボードのフォーカスでも出て、外れたら戻る', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    ev('focusin', a());
    vi.advanceTimersByTime(500);
    expect(tip()!.hidden).toBe(false);
    ev('focusout', a());
    expect(tip()!.hidden).toBe(true);
    expect(a().getAttribute('title')).toBe('保存する');
  });
  it('uninstall で要素と退避が消える', () => {
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    off();
    expect(tip()).toBeNull();
    expect(a().getAttribute('title')).toBe('保存する');
  });
  it('pointerdown → focusin(クリックで移ったフォーカス)では出ない', () => {
    ev('pointerdown', a());
    ev('focusin', a());
    vi.advanceTimersByTime(500);
    expect(tip()).toBeNull();
    expect(a().getAttribute('title')).toBe('保存する');
  });
  it('keydown → focusin では出る。その後 pointerdown に戻ると出ない', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    ev('focusin', a());
    vi.advanceTimersByTime(500);
    expect(tip()!.hidden).toBe(false);
    ev('pointerdown', a());
    expect(tip()!.hidden).toBe(true);
    ev('focusin', a());
    vi.advanceTimersByTime(500);
    expect(tip()!.hidden).toBe(true);
  });
  it('名前も中身の字も無い要素には、退避の間だけ aria-label を一時付与し、自分の値なら外す', () => {
    document.body.insertAdjacentHTML('beforeend', '<button id="i" title="閉じる"></button>');
    const i = document.getElementById('i')!;
    ev('pointerover', i);
    expect(i.getAttribute('aria-label')).toBe('閉じる');
    expect(i.hasAttribute('title')).toBe(false);
    ev('pointerout', i, { relatedTarget: document.body });
    expect(i.hasAttribute('aria-label')).toBe(false);
    expect(i.getAttribute('title')).toBe('閉じる');
    // 退避中に別の値へ書き換えられていたら外さない
    ev('pointerover', i);
    i.setAttribute('aria-label', '別の名前');
    ev('pointerout', i, { relatedTarget: document.body });
    expect(i.getAttribute('aria-label')).toBe('別の名前');
  });
  it('中身の字がある要素・aria-label がある要素には aria-label を足さない', () => {
    ev('pointerover', a());
    expect(a().hasAttribute('aria-label')).toBe(false);
    ev('pointerout', a(), { relatedTarget: document.body });
    const b = document.getElementById('b')!;
    ev('pointerover', b);
    expect(b.getAttribute('aria-label')).toBe('開く');
    ev('pointerout', b, { relatedTarget: document.body });
    expect(b.getAttribute('aria-label')).toBe('開く');
  });
  it('既存の aria-describedby は上書きも削除もしない', () => {
    a().setAttribute('aria-describedby', 'other');
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    expect(a().getAttribute('aria-describedby')).toBe('other');
    ev('pointerout', a(), { relatedTarget: document.body });
    expect(a().getAttribute('aria-describedby')).toBe('other');
  });
  it('退避中に消したら(setTipTitle null)、離れても戻らない', () => {
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    setTipTitle(a(), null);
    ev('pointerout', a(), { relatedTarget: document.body });
    expect(a().hasAttribute('title')).toBe(false);
    expect(a().hasAttribute(TIP_STASH_ATTR)).toBe(false);
  });
  it('退避中に消したら(setTipTitle null)、出ている吹き出しも消える', async () => {
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    setTipTitle(a(), null);
    await Promise.resolve();
    expect(tip()!.hidden).toBe(true);
  });
  it('退避中に title を書き換えたら、新しい字を表示し、離れたら新しい字が残る', async () => {
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    expect(tip()!.textContent).toBe('保存する');
    a().setAttribute('title', '上書き');
    await Promise.resolve();
    expect(a().hasAttribute('title')).toBe(false); // 再び外れている(標準の吹き出しと二重にしない)
    expect(a().getAttribute(TIP_STASH_ATTR)).toBe('上書き');
    expect(tip()!.textContent).toBe('上書き');
    ev('pointerout', a(), { relatedTarget: document.body });
    expect(a().getAttribute('title')).toBe('上書き');
    expect(a().hasAttribute(TIP_STASH_ATTR)).toBe(false);
  });
  it('待ちの間(出る前)に title を書き換えても新しい字が出る', async () => {
    ev('pointerover', a());
    a().setAttribute('title', '待ち中の上書き');
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(tip()!.textContent).toBe('待ち中の上書き');
  });
  it('setTipTitle / getTipTitle: 退避していなければ title を直接書く・消す。退避中でも今の字を返す', () => {
    setTipTitle(a(), '直接');
    expect(a().getAttribute('title')).toBe('直接');
    expect(getTipTitle(a())).toBe('直接');
    ev('pointerover', a());
    expect(getTipTitle(a())).toBe('直接');
    setTipTitle(a(), '退避中の更新');
    expect(getTipTitle(a())).toBe('退避中の更新');
    expect(a().hasAttribute('title')).toBe(false);
    ev('pointerout', a(), { relatedTarget: document.body });
    expect(a().getAttribute('title')).toBe('退避中の更新');
    setTipTitle(a(), null);
    expect(a().hasAttribute('title')).toBe(false);
  });
  it('開いているダイアログの中の対象では、吹き出しをダイアログの子として載せる', () => {
    document.body.insertAdjacentHTML('beforeend', '<dialog open id="d"><button id="x" title="中のボタン">X</button></dialog>');
    ev('pointerover', document.getElementById('x')!);
    vi.advanceTimersByTime(500);
    expect(tip()!.parentElement).toBe(document.getElementById('d'));
    ev('pointerout', document.getElementById('x')!, { relatedTarget: document.body });
    ev('pointerover', a());
    vi.advanceTimersByTime(500);
    expect(tip()!.parentElement).toBe(document.body);
  });
});
