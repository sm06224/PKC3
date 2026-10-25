/** @vitest-environment node */
/**
 * 🔴 #550: 本文中のタグを保存時に frontmatter の `body-tags:` へ集約する。
 * 互換: 文書タグ `tags:` と混ざらない / 旧ビルドは未知キーとして残す / 0 件ならキーを消す / 差分なしは書かない。
 */
import { describe, expect, it } from 'vitest';
import { applyBodyRewrite, BODY_TAGS_KEY } from '../../../src/features/markdown/body-rewrite';
import { parseFrontmatter } from '../../../src/features/markdown/frontmatter';
import { readTags } from '../../../src/features/flavor/tags';
import { isTagKey } from '../../../src/features/flavor/tag-words';
import { initialState, reduce } from '../../../src/adapter/state/app-state';
import type { EntryMeta } from '../../../src/core/model/entry-meta';

const sync = (b: string) => applyBodyRewrite(b, { kind: 'body-tags-sync' });

describe('body-tags-sync (#550)', () => {
  it('本文のタグを重複排除して body-tags: に書く。tags: は触らず混ざらない', () => {
    const body = '---\ntags: [手書き]\n---\n# 見出し\n#請求 #家事\n\n## 次\n#請求\n';
    const out = sync(body)!;
    expect(out).not.toBe(body);
    const fm = parseFrontmatter(out).meta;
    expect(fm[BODY_TAGS_KEY]).toEqual(['請求', '家事']);
    expect(fm['tags']).toEqual(['手書き']);
    expect(readTags(out)).toEqual(['手書き']);
    expect(out.endsWith('---\n# 見出し\n#請求 #家事\n\n## 次\n#請求\n')).toBe(true);
  });

  it('frontmatter が無い本文には前書きを作って書く', () => {
    const out = sync('#a1 #b2\n本文')!;
    expect(out.startsWith('---\nbody-tags: [a1, b2]\n---\n')).toBe(true);
    expect(readTags(out)).toEqual([]);
  });

  it('差分なし(冪等): 2 回目は同じ本文を返す。0 件で元から無ければ何も足さない', () => {
    const once = sync('#a1\n')!;
    expect(sync(once)).toBe(once);
    expect(sync('ただの本文')).toBe('ただの本文');
  });

  it('本文のタグを消したら集約からも消え、0 件ならキーごと消える', () => {
    const one = sync('---\ntags: [x]\n---\n#a1 #b2\n')!;
    const less = sync(one.replace('#a1 #b2', '#b2'))!;
    expect(parseFrontmatter(less).meta[BODY_TAGS_KEY]).toEqual(['b2']);
    const none = sync(less.replace('#b2', 'なし'))!;
    expect(parseFrontmatter(none).meta[BODY_TAGS_KEY]).toBeUndefined();
    expect(none).not.toContain('body-tags');
    expect(parseFrontmatter(none).meta['tags']).toEqual(['x']);
  });

  it('frontmatter の中の # や見出し(# 見出し)は集約されない', () => {
    const body = '---\nmemo: x # #hidden\n---\n# 見出し\n本文\n';
    expect(sync(body)).toBe(body);
  });

  it('旧ビルド互換: body-tags は文書タグの key ではない(未知キーとして残るだけ)', () => {
    expect(isTagKey(BODY_TAGS_KEY)).toBe(false);
  });

  it('コンマや記号を含む名前も往復で同じ', () => {
    const out = sync('#a,b #c]d\n')!;
    expect(parseFrontmatter(out).meta[BODY_TAGS_KEY]).toEqual(['a,b', 'c]d']);
    expect(sync(out)).toBe(out);
  });
});

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't',
    archetype: 'text',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

describe('COMMIT_EDIT の保存門 (#550)', () => {
  function editing(body: string) {
    let s = reduce(initialState, { type: 'SYS_BOOTED', cid: 'c1', metas: [meta('a')], relations: [] }).state;
    s = reduce(s, { type: 'SELECT_ENTRY', lid: 'a' }).state;
    s = reduce(s, { type: 'BODY_LOADED', lid: 'a', body }).state;
    return reduce(s, { type: 'START_EDIT' }).state;
  }
  const persisted = (r: ReturnType<typeof reduce>) =>
    (r.events.find((e) => e.type === 'PERSIST_ENTRY') as { entry: { body: string } } | undefined)
      ?.entry.body;

  it('変更ありの保存で body-tags が書かれる', () => {
    const s = reduce(editing('# A'), { type: 'UPDATE_OPEN_BODY', body: '# A\n#請求\n' }).state;
    const r = reduce(s, { type: 'COMMIT_EDIT' });
    const b = persisted(r);
    expect(b).toBeDefined();
    expect(parseFrontmatter(b!).meta[BODY_TAGS_KEY]).toEqual(['請求']);
    expect(r.state.openBody?.body).toBe(b);
  });

  it('変更なしの保存は書かない(無駄な書き換えを起こさない)', () => {
    const r = reduce(editing('# A\n#請求\n'), { type: 'COMMIT_EDIT' });
    expect(persisted(r)).toBeUndefined();
    expect(r.state.openBody?.body).toBe('# A\n#請求\n');
  });
});
