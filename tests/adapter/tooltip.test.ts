/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTooltip, TIP_ID, TIP_STASH_ATTR } from '@adapter/ui/render/tooltip';

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
});
