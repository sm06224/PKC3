/** @vitest-environment happy-dom */
/**
 * 🔴 **ツールチップ表示中(title 退避中)に、呼び側が title を空にしても、離れたとき古い字が戻らない**(#1982 A3)。
 *
 * 型は全部同じ: hover → 400ms(退避が働き表示される)→ 呼び側が空にする → pointerout → title が無いまま。
 * ⚠ 前提(退避が実際に起きていた / 対照として呼び側が別の字を書くと残る)を各 it で先に確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTooltip, TIP_STASH_ATTR } from '../../src/adapter/ui/render/tooltip';
import { buildShell, paintCaptureBar } from '../../src/adapter/ui/render/shell';
import { ScheduleDay } from '../../src/adapter/ui/render/schedule-day';
import { createTaskCard, patchTaskCard } from '../../src/adapter/ui/render/task-card';
import {
  applyMissingLinks,
  MISSING_ATTR,
  MISSING_LINK_TITLE,
} from '../../src/adapter/ui/render/link-missing';
import { applyTitleLinks } from '../../src/adapter/ui/render/title-links';
import { syncWrapHint, WRAPS_SELECTION_ATTR } from '../../src/adapter/ui/render/format-wrap-hint';
import { WRAP_HINT } from '../../src/adapter/ui/render/shortcut-hint';
import type { AgendaItem } from '../../src/features/schedule/agenda';

let off: () => void;
beforeEach(() => {
  vi.useFakeTimers();
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
/** hover して表示まで進める(退避が実際に起きたことを確かめる)。 */
function hoverShown(el: Element): void {
  ev('pointerover', el);
  vi.advanceTimersByTime(500);
  expect(el.hasAttribute('title'), '前提: 退避中は title が無い').toBe(false);
  expect(el.hasAttribute(TIP_STASH_ATTR), '前提: 退避が働いている').toBe(true);
  expect(document.getElementById('pkc-tooltip')!.hidden, '前提: 吹き出しが出ている').toBe(false);
}
const leave = (el: Element): void => ev('pointerout', el, { relatedTarget: document.body });

describe('呼び側の「title を空にする」が退避中でも効く', () => {
  it('paintCaptureBar(収録の帯の字)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    paintCaptureBar(root, '録音中 0:07', '録音中 0:07(約 12 KB)');
    const text = root.querySelector<HTMLElement>('[data-pkc-field="capture-status"]')!;
    expect(text.getAttribute('title')).toBe('録音中 0:07(約 12 KB)');
    hoverShown(text);
    paintCaptureBar(root, '録音中 0:08', null);
    leave(text);
    expect(text.hasAttribute('title'), '古い説明が復活した').toBe(false);
    expect(text.hasAttribute(TIP_STASH_ATTR)).toBe(false);
  });

  it('paintCaptureBar: 退避中に別の説明へ変えたら、離れたあと新しい字が残る(対照)', () => {
    const root = document.createElement('div');
    document.body.append(root);
    buildShell(root);
    paintCaptureBar(root, '録音中 0:07', '古い');
    const text = root.querySelector<HTMLElement>('[data-pkc-field="capture-status"]')!;
    hoverShown(text);
    paintCaptureBar(root, '録音中 0:08', '新しい');
    leave(text);
    expect(text.getAttribute('title')).toBe('新しい');
  });

  it('ScheduleDay(祝日の見出し → 祝日でない日へ描き直す)', () => {
    const day = new ScheduleDay('data-pkc-drop-day');
    document.body.append(day.el);
    const paint = (d: string) =>
      day.paint({ day: d, today: '2026-01-05', items: [], titleOf: () => '', selectedLid: null, year: 2026, settled: true });
    paint('2026-01-01'); // 元日
    const label = day.el.querySelector<HTMLElement>('[data-pkc-field="schedule-day-label"]')!;
    expect(label.getAttribute('title'), '前提: 祝日の名前が title に出ている').toBeTruthy();
    hoverShown(label);
    paint('2026-01-06'); // 祝日でない日
    leave(label);
    expect(label.hasAttribute('title'), '古い祝日名が復活した').toBe(false);
  });

  const item = (repeat: AgendaItem['repeat']): AgendaItem =>
    ({
      key: 'k',
      lid: 'e1',
      line: 3,
      done: false,
      repeat,
      text: '予定',
      day: '2026-01-06',
      time: null,
      endTime: null,
    }) as unknown as AgendaItem;

  it('task-card(繰り返しの札 → 繰り返しでない札へ使い回す)', () => {
    const rep = item('day');
    const card = createTaskCard(rep);
    document.body.append(card);
    patchTaskCard(card, rep, 't', 2026, false);
    const box = card.querySelector<HTMLElement>('[data-pkc-action="toggle-task"]')!;
    expect(box.getAttribute('title'), '前提: 繰り返しの説明が付いている').toContain('済みにします');
    hoverShown(box);
    patchTaskCard(card, item(null), 't', 2026, false);
    leave(box);
    expect(box.hasAttribute('title'), '古い説明が復活した').toBe(false);
  });

  it('link-missing(無いリンクが、ノートが出来て「在る」に変わる)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<a data-pkc-entry-ref="entry:gone">x</a>';
    document.body.append(host);
    const a = host.querySelector<HTMLElement>('a')!;
    applyMissingLinks(host, () => false, 'cid');
    expect(a.getAttribute('title'), '前提: 「無い」の説明が付いている').toBe(MISSING_LINK_TITLE);
    expect(a.hasAttribute(MISSING_ATTR)).toBe(true);
    hoverShown(a);
    applyMissingLinks(host, () => true, 'cid');
    leave(a);
    expect(a.hasAttribute('title'), '古い「無い」説明が復活した').toBe(false);
    expect(a.hasAttribute(MISSING_ATTR)).toBe(false);
  });

  it('link-missing: 退避中でも、「無い」説明を自分が付けたかを退避の字で判定する(対照: 利用者の title は残る)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<a data-pkc-entry-ref="entry:gone" title="自分の説明">x</a>';
    document.body.append(host);
    const a = host.querySelector<HTMLElement>('a')!;
    applyMissingLinks(host, () => false, 'cid');
    expect(a.getAttribute('title')).toBe('自分の説明');
    hoverShown(a);
    applyMissingLinks(host, () => true, 'cid');
    leave(a);
    expect(a.getAttribute('title')).toBe('自分の説明');
  });

  it('title-links(同型)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<a class="pkc-title-link" data-pkc-title="あ">あ</a>';
    document.body.append(host);
    const a = host.querySelector<HTMLElement>('a')!;
    applyTitleLinks(host, []);
    expect(a.getAttribute('title'), '前提: 「無い」の説明が付いている').toBeTruthy();
    hoverShown(a);
    applyTitleLinks(host, [{ lid: 'n1', title: 'あ', archetype: 'text' } as never]);
    leave(a);
    expect(a.hasAttribute('title'), '古い説明が復活した').toBe(false);
  });
  it('format-wrap-hint(退避中に選択の有無が変わっても、戻す字を失わない)', () => {
    const bar = document.createElement('div');
    bar.innerHTML = `<button ${WRAPS_SELECTION_ATTR} title="元の説明">B</button>`;
    document.body.append(bar);
    const btn = bar.querySelector<HTMLElement>('button')!;
    hoverShown(btn);
    // 範囲を選んだ(on)── 退避中でも「元の説明」を預かれること(el.title は退避中 '' を返す)
    expect(syncWrapHint(bar, true), '前提: 書き換わった').toBe(1);
    expect(btn.getAttribute('data-pkc-wrap-rest'), '預かる字が空(退避中の title を読み損ねた)').toBe('元の説明');
    leave(btn);
    expect(btn.getAttribute('title'), '離れたら範囲ありの説明').toBe(WRAP_HINT);
    // 選択が外れた(off)── 元の説明へ戻る
    expect(syncWrapHint(bar, false)).toBe(1);
    expect(btn.getAttribute('title')).toBe('元の説明');
  });
});
