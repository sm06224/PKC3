/** @vitest-environment node */
/**
 * P6: textlog permalink 書換(fromPkc2 より前段)の pin。
 * 対応先 = 変換後見出しの slug(時刻精度を落とさない)。未知 id は broken のまま。
 */
import { describe, expect, it } from 'vitest';
import { parseLinkTarget } from '../../src/features/entry-ref/link-target';
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
    expect(out).toContain('[a](entry:tl1#h/2026-07-01-090000)');
    expect(out).toContain('[range](entry:tl1#h/2026-07-01-090000-1)'); // 先頭 log へ
    expect(out).toContain('[sub](entry:tl1#h/2026-07-02-103005)'); // 小見出しは落とす
    expect(out).toContain('[day](entry:tl1#h/2026-07-01-090000)'); // その日の先頭 log
    expect(out).toContain('[frag](#2026-07-02-103005)'); // 同一 entry 内
    expect(out).toContain('[legacy](entry:tl1#h/2026-07-01-090000-1)'); // 裸 fragment
    expect(out).toContain('[unknown](entry:tl1#log/gone-id)'); // 壊れシグナル保存
    expect(out).toContain('[other](entry:other9#log/xyz)'); // 未知 entry も不変
    expect(out).toContain('散文中の #log/log-x は書き換えない');
  });

  it('書き換えた別ノートへのリンクは PKC3 の節リンクとして読め、見出しの id が取れる', () => {
    const anchorsByLid = new Map([['tl1', anchors]]);
    const days = new Map([['tl1', buildFirstLogOfDay(body, anchors)]]);
    for (const src of ['[a](entry:tl1#log/log-x)', '[d](entry:tl1#day/2026-07-01)', '[l](entry:tl1#log-x)']) {
      const out = rewriteTextlogRefs(src, 'other', anchorsByLid, days);
      const href = /\((entry:[^)]+)\)/.exec(out)![1]!;
      const t = parseLinkTarget(href);
      expect(t.kind).toBe('entry');
      expect(t.kind === 'entry' ? t.section : null, `${src} → ${href}`).not.toBeNull();
    }
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

/**
 * 🔴 日時の無い記録の行(台帳 #1852 I2 / 依頼 158。Gemini 回答 = 推薦 ②)。
 * 直す前は、日時の無い行の見出しに「取り込んだ時刻」が入り、本当の日付と関係のない日の記録に見えた。
 */
describe('日時の無い行の見出し(依頼 158)', () => {
  const body = JSON.stringify({
    entries: [
      { id: 'a1', text: '朝', createdAt: '2026-07-01T09:00:00', flags: [] },
      { id: 'a2', text: '日時が無い', flags: [] },
      { id: 'a3', text: '空の日時', createdAt: '', flags: ['important'] },
    ],
  });

  it('🔴 日時の無い行(欠けている / 空)の見出しは `(日時なし)`。取り込んだ時刻は書かない', () => {
    const md = textlogFlavor.fromPkc2!(body);
    expect(md).toBe('## 2026-07-01 09:00:00\n\n朝\n\n## (日時なし)\n\n日時が無い\n\n## (日時なし) ★\n\n空の日時');
  });

  it('リンクの書き換えも同じ字を探す(日時の無い行へのリンクが行き先を見失わない)', () => {
    const md = textlogFlavor.fromPkc2!(body);
    const anchors = buildTextlogAnchorMap(body, md);
    expect(anchors.get('a1')).toBe('2026-07-01-090000');
    expect(anchors.has('a2')).toBe(true);
    expect(anchors.has('a3')).toBe(true);
    expect(anchors.get('a2')).not.toBe(anchors.get('a3'));
  });

  it('日付ごとの先頭の行には、日時の無い行を数えない(読んだ時刻の日に寄せない)', () => {
    const md = textlogFlavor.fromPkc2!(body);
    const anchors = buildTextlogAnchorMap(body, md);
    const days = buildFirstLogOfDay(body, anchors);
    expect([...days.keys()]).toEqual(['2026-07-01']);
  });

  it('対照群:日時のある行は今までどおり(書式が壊れた日時は原文の字を残す)', () => {
    const md = textlogFlavor.fromPkc2!(JSON.stringify({ entries: [{ text: 'x', createdAt: 'いつか' }] }));
    expect(md).toBe('## いつか\n\nx');
  });
});
