/**
 * P6: textlog permalink 書換(fromPkc2 より前段)の pin。
 * 対応先 = 変換後見出しの slug(時刻精度を落とさない)。未知 id は broken のまま。
 */
import { describe, expect, it } from 'vitest';
import { textlogFlavor } from '../../src/features/flavor/textlog-flavor';
import {
  buildTextlogAnchorMap,
  buildFirstLogOfDay,
  rewriteTextlogRefs,
} from '../../src/features/import/textlog-anchors';

// createdAt は TZ 指定なしのローカル形で渡す(見出しはローカル時刻で焼かれる)
function pkc2Textlog(
  entries: Array<{ id: string; text: string; createdAt: string; flags?: string[] }>,
): string {
  return JSON.stringify({ entries: entries.map((e) => ({ flags: [], ...e })) });
}

describe('textlog anchors (P6)', () => {
  const body = pkc2Textlog([
    { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', text: '朝の記録', createdAt: '2026-07-01T09:00:00' },
    { id: 'log-1719800000-2', text: '', createdAt: '2026-07-01T09:00:00' }, // 同秒 = slug 衝突
    {
      id: 'log-x',
      text: '## 偽見出し\n\n本文',
      createdAt: '2026-07-02T10:30:05',
      flags: ['important'],
    },
  ]);
  const converted = textlogFlavor.fromPkc2!(body);
  const anchors = buildTextlogAnchorMap(body, converted);

  it('ULID / legacy id とも slug に対応し、同秒衝突は -1 連番で弁別される', () => {
    expect(anchors.get('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('2026-07-01-090000');
    expect(anchors.get('log-1719800000-2')).toBe('2026-07-01-090000-1');
    // ★(important)付き見出し・text 内の偽見出しが挟まっても対応が取れる
    expect(anchors.get('log-x')).toBe('2026-07-02-103005');
  });

  it('permalink 5 変種の書換 + 未知 id は broken のまま', () => {
    const anchorsByLid = new Map([['tl1', anchors]]);
    const days = new Map([['tl1', buildFirstLogOfDay(body, anchors)]]);
    const src = [
      '[a](entry:tl1#log/01ARZ3NDEKTSV4RRFFQ69G5FAV)',
      '[range](entry:tl1#log/log-1719800000-2..log-x)',
      '[sub](entry:tl1#log/log-x/some-heading)',
      '[day](entry:tl1#day/2026-07-01)',
      '[frag](#log/log-x)',
      '[legacy](entry:tl1#log-1719800000-2)',
      '[unknown](entry:tl1#log/gone-id)',
      '[other](entry:other9#log/xyz)',
      '散文中の #log/log-x は書き換えない',
    ].join('\n');
    const out = rewriteTextlogRefs(src, 'tl1', anchorsByLid, days);
    expect(out).toContain('[a](entry:tl1#2026-07-01-090000)');
    expect(out).toContain('[range](entry:tl1#2026-07-01-090000-1)'); // 先頭 log へ
    expect(out).toContain('[sub](entry:tl1#2026-07-02-103005)'); // 小見出しは落とす
    expect(out).toContain('[day](entry:tl1#2026-07-01-090000)'); // その日の先頭 log
    expect(out).toContain('[frag](#2026-07-02-103005)'); // 同一 entry 内
    expect(out).toContain('[legacy](entry:tl1#2026-07-01-090000-1)'); // 裸 fragment
    expect(out).toContain('[unknown](entry:tl1#log/gone-id)'); // 壊れシグナル保存
    expect(out).toContain('[other](entry:other9#log/xyz)'); // 未知 entry も不変
    expect(out).toContain('散文中の #log/log-x は書き換えない');
  });

  it('書換済み slug を legacy 裸 fragment として二重書換しない(冪等)', () => {
    const anchorsByLid = new Map([['tl1', anchors]]);
    const days = new Map([['tl1', buildFirstLogOfDay(body, anchors)]]);
    const once = rewriteTextlogRefs(
      '[a](entry:tl1#log/log-x)',
      'tl1',
      anchorsByLid,
      days,
    );
    expect(rewriteTextlogRefs(once, 'tl1', anchorsByLid, days)).toBe(once);
  });
});
