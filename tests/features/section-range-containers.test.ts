/** @vitest-environment node */
/**
 * 台帳 #1852 束 R1(依頼 272): 章の範囲は、囲み(`:::note` など)の途中で切らず、画面に出ない見出しでは切らない。
 */
import { describe, expect, it } from 'vitest';
import { listAppendTargets, sectionRange } from '../../src/features/markdown/append-target';
import { sectionExcerptOf } from '../../src/features/markdown/section-embed';

const slice = (body: string, slug: string): string => {
  const r = sectionRange(body, slug);
  expect(r, `${slug} が解けない`).not.toBeNull();
  return body.split('\n').slice(r!.start, r!.end).join('\n');
};

describe('囲みの中の見出しでは、外の章を切らない', () => {
  const body = [
    '# 一',
    '前',
    ':::note',
    '## 囲みの中',
    '中の字',
    ':::',
    '後',
    '# 二',
    '次',
  ].join('\n');

  it('🔴 章「一」は、囲みを丸ごと含み、閉じ `:::` まで入る(以前は囲みの途中で切れ、閉じていない枠が出た)', () => {
    const got = slice(body, '一');
    expect(got).toBe(['# 一', '前', ':::note', '## 囲みの中', '中の字', ':::', '後'].join('\n'));
    expect(got).not.toContain('# 二');
  });

  it('囲みの中の見出し自身を指したときは、囲みの閉じを越えない', () => {
    const got = slice(body, '囲みの中');
    expect(got).toBe(['## 囲みの中', '中の字'].join('\n'));
    expect(got).not.toContain('後');
  });

  it('対照群: 囲みの外の同格の見出しでは今までどおり切れる', () => {
    expect(slice(body, '二')).toBe('# 二\n次');
  });

  it('閉じていない囲みは囲みにしない(後ろの見出し全部が「囲みの中」になって章が切れなくなるのを避ける)', () => {
    const open = ['# 一', ':::note', '字', '# 二', '次'].join('\n');
    expect(slice(open, '一')).toBe(['# 一', ':::note', '字'].join('\n'));
  });

  it('入れ子の囲みも内側の閉じで終わる / 一覧には囲みの中の見出しも残る(id の連番を描画と揃える)', () => {
    const nested = ['# 一', ':::note', '## 内', ':::details', '### さらに内', ':::', '内の続き', ':::', '# 二'].join('\n');
    expect(slice(nested, '一')).toBe(['# 一', ':::note', '## 内', ':::details', '### さらに内', ':::', '内の続き', ':::'].join('\n'));
    expect(slice(nested, 'さらに内')).toBe('### さらに内');
    expect(listAppendTargets(nested).map((t) => t.slug)).toEqual(['一', '内', 'さらに内', '二']);
  });

  it('コードの囲みの中の `:::` は囲みではない', () => {
    const code = ['# 一', '```', ':::note', '```', '# 二'].join('\n');
    expect(slice(code, '一')).toBe(['# 一', '```', ':::note', '```'].join('\n'));
  });

  it('埋め込みの切り出しも同じ範囲(閉じていない空の枠が出ない)', () => {
    expect(sectionExcerptOf(body, '一').text).toBe(['# 一', '前', ':::note', '## 囲みの中', '中の字', ':::', '後'].join('\n'));
  });
});

describe('画面に出ない囲みの中の見出しは数えない', () => {
  const body = [
    '# 一',
    '見える',
    ':::if{format=docx}',
    '# Word だけの見出し',
    '隠れた字',
    ':::',
    '見える続き',
    '# 二',
  ].join('\n');

  it('🔴 Word のときだけ出す囲みの中の見出しでは切れない(見えている文が前の章から落ちない)', () => {
    expect(slice(body, '一')).toContain('見える続き');
    expect(listAppendTargets(body).map((t) => t.slug)).toEqual(['一', '二']);
  });

  it('画面に出る囲み(format=html)の中の見出しは、今までどおり見出しとして数える', () => {
    const shown = body.replace('format=docx', 'format=html');
    expect(listAppendTargets(shown).map((t) => t.slug)).toEqual(['一', 'word-だけの見出し', '二']);
  });
});
