/** @vitest-environment happy-dom */
/**
 * 🔴 **情報ペインの「作成 / 更新」は端末の暦日で出て、`<time datetime>` に UTC の
 * 瞬間を持つ**(#709 案 A)。
 *
 * 直す前は DB の字(UTC)の先頭 10 字をそのまま出していたので、日本の 0 時〜9 時に
 * 書いたノートは**前日**で出た(cowork 実測 2026-09-05 07:00 JST: 題名は
 * `2026-09-05 ノート 1`、作成 / 更新欄は `2026/09/04`)。
 *
 * 🔑 TZ を切り替えて **字が変わり、`datetime` は変わらない**ことを見る ──
 *   字は user の暦、属性は機械のための 1 つの瞬間。
 */
import { describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import { initialState, type AppState } from '../../src/adapter/state/app-state';
import { InspectorRenderer } from '../../src/adapter/ui/render/inspector';

const META = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'e1',
  title: 'ノート',
  archetype: 'text',
  entryOrder: 0,
  createdAt: '2026-08-04 23:30:00', // UTC ── JST では 8/5 08:30
  updatedAt: '2026-08-04 23:30:00',
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
  ...over,
});

function stateOf(meta: EntryMeta): AppState {
  return {
    ...initialState,
    phase: 'ready',
    selectedLid: meta.lid,
    entryMetas: new Map([[meta.lid, meta]]),
  } as AppState;
}

function withTZ<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

function paint(meta: EntryMeta): HTMLElement {
  document.body.innerHTML = '';
  const region = document.createElement('div');
  document.body.append(region);
  new InspectorRenderer(region).render(stateOf(meta));
  return region;
}

const cell = (region: HTMLElement, field: string): HTMLElement =>
  region.querySelector<HTMLElement>(`[data-pkc-field="${field}"]`)!;

describe('情報ペインの作成 / 更新(#709)', () => {
  it('⚠ 対照群 ── TZ の切り替えが効いている', () => {
    expect(withTZ('Asia/Tokyo', () => new Date('2026-08-04T23:30:00Z').getDate())).toBe(5);
    expect(withTZ('UTC', () => new Date('2026-08-04T23:30:00Z').getDate())).toBe(4);
  });

  it('🔴 字は端末の暦日(JST では翌日、UTC ではその日)', () => {
    withTZ('Asia/Tokyo', () => {
      const r = paint(META());
      expect(cell(r, 'inspector-created').textContent).toBe('2026/08/05');
      expect(cell(r, 'inspector-updated').textContent).toBe('2026/08/05');
    });
    withTZ('UTC', () => {
      const r = paint(META());
      expect(cell(r, 'inspector-created').textContent).toBe('2026/08/04');
    });
  });

  it('🔴 `<time datetime>` に UTC の瞬間が付き、TZ を変えても変わらない', () => {
    for (const tz of ['Asia/Tokyo', 'UTC']) {
      withTZ(tz, () => {
        const r = paint(META());
        const t = cell(r, 'inspector-created').querySelector('time');
        expect(t, `TZ=${tz}: <time> が無い`).not.toBeNull();
        expect(t!.getAttribute('datetime'), `TZ=${tz}`).toBe('2026-08-04T23:30:00.000Z');
        expect(cell(r, 'inspector-updated').querySelector('time')!.getAttribute('datetime')).toBe(
          '2026-08-04T23:30:00.000Z',
        );
      });
    }
  });

  it('値が無い / 読めないときは字は今までどおり、属性は付かない(古い値を残さない)', () => {
    const region = document.createElement('div');
    document.body.innerHTML = '';
    document.body.append(region);
    const ins = new InspectorRenderer(region);
    ins.render(stateOf(META()));
    const t = () => cell(region, 'inspector-created').querySelector('time')!;
    expect(t().hasAttribute('datetime')).toBe(true);
    // 同じ器で値が消えたら、属性も外れる(⚠ 別のノートへ移ると createdAt が null の行も在る)
    ins.render(stateOf(META({ lid: 'e2', createdAt: null })));
    expect(cell(region, 'inspector-created').textContent).toBe('—');
    expect(t().hasAttribute('datetime'), '古い datetime が残っている').toBe(false);
    // 形の違う字はそのまま出て、属性は付かない
    ins.render(stateOf(META({ lid: 'e3', createdAt: 'なにか' })));
    expect(cell(region, 'inspector-created').textContent).toBe('なにか');
    expect(t().hasAttribute('datetime')).toBe(false);
  });

  it('⚠ 描き直しても <time> は 1 つ(増殖しない)', () => {
    const region = document.createElement('div');
    document.body.innerHTML = '';
    document.body.append(region);
    const ins = new InspectorRenderer(region);
    ins.render(stateOf(META()));
    ins.render(stateOf(META({ updatedAt: '2026-08-05 01:00:00' })));
    ins.render(stateOf(META({ updatedAt: '2026-08-05 02:00:00' })));
    expect(cell(region, 'inspector-updated').querySelectorAll('time')).toHaveLength(1);
  });
});
