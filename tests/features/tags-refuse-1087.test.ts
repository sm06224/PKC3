/** @vitest-environment node */
/**
 * #1087: タグの書換は、書けないノートには書かず理由を返す。
 * - 前書きが読めない(読めた分は空 ── そのまま書くと既存のタグが消える)
 * - 字下げした入れ子の `tags:`(読む側は読む・書く側は最上位の行しか書かない)
 * - スマートフォルダの条件のタグの改名
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite, applyTagsToBody } from '../../src/features/markdown/body-rewrite';
import { readSmartSpec, withSmartTagRenamed, writeSmartSpec } from '../../src/features/smart/smart-spec';
import { readTags } from '../../src/features/flavor/tags';

const NO_CLOSE = '---\ntags: [買い物, 家事]\n本文です\n';
const BIG = `---\ntags: [買い物, 家事]\nmemo: ${'あ'.repeat(17000)}\n---\n本文です\n`;

describe('読めない前書きには書かない', () => {
  for (const [label, body] of [
    ['閉じが無い', NO_CLOSE],
    ['16KB 超', BIG],
  ] as const) {
    for (const mode of ['add', 'remove'] as const) {
      it(`${label} / ${mode}: 書かず・outcomes を持たず・理由が unreadable`, () => {
        const r = applyTagsToBody(body, mode === 'add' ? ['請求'] : ['買い物'], mode);
        expect(r.body).toBeNull();
        expect(r.refused).toBe('unreadable');
        expect(r.outcomes.size).toBe(0);
      });
    }
  }

  it('対照群: 読める前書きは通常どおり書ける(門が全部を止めていない)', () => {
    const r = applyTagsToBody('---\ntags: [買い物]\n---\n本文\n', ['請求'], 'add');
    expect(r.refused).toBeUndefined();
    expect(readTags(r.body!)).toEqual(['買い物', '請求']);
  });

  it('対照群: 前書きの無いノートにも書ける(水平線だけで始まる本文も同じ)', () => {
    expect(readTags(applyTagsToBody('あ\n', ['請求'], 'add').body!)).toEqual(['請求']);
    expect(applyTagsToBody('---\n\n本文\n', ['請求'], 'add').refused).toBeUndefined();
  });

  it('applyBodyRewrite(tag) も書かない(null)', () => {
    expect(applyBodyRewrite(NO_CLOSE, { kind: 'tag', tags: ['請求'], mode: 'add' })).toBeNull();
  });
});

describe('字下げした入れ子のタグ', () => {
  it('外す: 書ける行が無いので unwritable(本文は返さない)', () => {
    const r = applyTagsToBody('---\nmeta:\n  tags: [zz]\n---\n本文\n', ['zz'], 'remove');
    expect(r.body).toBeNull();
    expect(r.refused).toBe('unwritable');
  });

  it('外す(他のタグが残る形): 最上位に `tags:` を増やさない', () => {
    const r = applyTagsToBody('---\nmeta:\n  tags: [zz, y]\n---\n本文\n', ['zz'], 'remove');
    expect(r.body).toBeNull();
    expect(r.refused).toBe('unwritable');
  });

  it('対照群: 最上位の `tags:` は今までどおり外せる', () => {
    const r = applyTagsToBody('---\ntags: [zz, y]\n---\n本文\n', ['zz'], 'remove');
    expect(readTags(r.body!)).toEqual(['y']);
    expect(r.refused).toBeUndefined();
  });

  it('対照群: 元から無いタグを外す回は、これまでどおり unchanged(unwritable ではない)', () => {
    const r = applyTagsToBody('---\ntags: [y]\n---\n本文\n', ['zz'], 'remove');
    expect(r.body).toBeNull();
    expect(r.refused).toBeUndefined();
    expect(r.outcomes.get('zz')).toBe('unchanged');
  });
});

describe('スマートフォルダの条件のタグの改名', () => {
  const smart = (tags: string[]): string => `---\nsmart-tags: [${tags.join(', ')}]\n---\n説明\n`;

  it('条件の同じ名前が新しい名前になる(並びは保つ)', () => {
    const spec = readSmartSpec(smart(['旧', '別']));
    const next = withSmartTagRenamed(spec, '旧', '新')!;
    expect(next.tags).toEqual(['新', '別']);
    expect(readSmartSpec(writeSmartSpec(smart(['旧', '別']), next)).tags).toEqual(['新', '別']);
  });

  it('大小だけ違う綴りの条件も改名される(タグの突き合わせは大小無視)', () => {
    expect(withSmartTagRenamed(readSmartSpec(smart(['Work'])), 'work', 'job')!.tags).toEqual(['job']);
  });

  it('新しい名前が既に条件に在れば、旧い名前を外すだけ(同じ名前を 2 つ並べない)', () => {
    expect(withSmartTagRenamed(readSmartSpec(smart(['旧', '新'])), '旧', '新')!.tags).toEqual(['新']);
  });

  it('条件に無い名前 / 条件にできない新しい名前は null(書かない)', () => {
    expect(withSmartTagRenamed(readSmartSpec(smart(['別'])), '旧', '新')).toBeNull();
    expect(withSmartTagRenamed(readSmartSpec(smart(['旧'])), '旧', '')).toBeNull();
  });
});
