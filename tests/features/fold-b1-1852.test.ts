/** @vitest-environment happy-dom */
/**
 * 台帳 #1852 の束 B1 ── 題名の絞り込みとタグで、字を揃えて比べる(#1163 依頼 173 / 174 / 175 / 176 / 195 / 258 / 276 / 335 / 115-2 / 115-6 / 129)。
 *
 * 守る主張:
 * 1. 揃える関数は 1 本(`foldText`)── 全角半角・半角カナ・濁点(結合と合成済み)・大小を同じ字にし、ひらがなとカタカナは別のまま
 * 2. 題名の絞り込みは (1) を通る。ノートの題名そのものは変わらない
 * 3. タグの突き合わせ・集計の組・色の鍵も (1) を通る(同じ判定を 2 か所に書かない)
 * 4. タグの末尾の読点・句点は外して読む
 * 5. 取り込みで `Tags:` / `tag:` / `keywords:` も読む。書き直すときに別名の行が残ってタグが戻らない
 * 6. `.md` の更新日(file の lastModified)を引き継ぐ。未来や 0 は「いま」
 */
import { describe, expect, it } from 'vitest';
import { foldText } from '../../src/features/filter/fold-text';
import { matchesTitle, normalizeQuery } from '../../src/features/filter/title-filter';
import { normalizeTag, readTags, sameTag, splitTags, tagFoldKey } from '../../src/features/flavor/tags';
import { collectEntryTags } from '../../src/features/flavor/entry-tags';
import { applyTagsToBody } from '../../src/features/markdown/body-rewrite';
import { tagColorKey } from '../../src/features/tag-color';
import { createQueryScan, TAGS_KEY } from '../../src/features/query/group-by';
import { readPlainMarkdown, stampOfFileTime } from '../../src/features/import/plain-markdown';
import { importMarkdownFiles, type MarkdownImportDeps } from '../../src/adapter/ui/actions/import-markdown';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';

// 結合文字は生の字で書かない(見た目が合成済みと同じで、読み手が取り違える)
const DAKUTEN = String.fromCharCode(0x3099);
const KA_COMBINING = 'か' + DAKUTEN; // 「か」+ 結合濁点(Mac のファイル名の形)
const GA_PRECOMPOSED = 'が'; // 合成済みの「が」
const HALF_HA_DAKU = 'ﾊﾞ'; // 半角カナ「ハ」+ 半角濁点

describe('foldText ── 揃えるもの / 揃えないもの', () => {
  it('前提: 結合の「が」と合成済みの「が」は、そのままでは別の字列', () => {
    expect(KA_COMBINING).not.toBe(GA_PRECOMPOSED);
    expect(KA_COMBINING.length).toBe(2);
  });

  it('全角英数と半角英数、大小が同じになる', () => {
    expect(foldText('ＡＢＣ１２３')).toBe(foldText('abc123'));
  });

  it('半角カナ(濁点つき含む)と全角カナが同じになる', () => {
    expect(foldText('ﾊﾝｶｸ')).toBe(foldText('ハンカク'));
    expect(foldText(HALF_HA_DAKU)).toBe(foldText('バ'));
  });

  it('濁点の持ち方(結合と合成済み)が同じになる', () => {
    expect(foldText(KA_COMBINING)).toBe(foldText(GA_PRECOMPOSED));
  });

  it('🔴 ひらがなとカタカナは別のまま(対照群: 揃えるものは上で揃っている)', () => {
    expect(foldText('りんご')).not.toBe(foldText('リンゴ'));
    expect(foldText('が')).not.toBe(foldText('ガ'));
  });
});

describe('題名の絞り込み(195 / 258 / 276 / 335 / 115-2)', () => {
  const hit = (title: string, typed: string): boolean => matchesTitle(title, normalizeQuery(typed));

  it('半角で打っても全角の題名が出る(逆も)', () => {
    expect(hit('ＡＢＣ報告', 'abc')).toBe(true);
    expect(hit('abc報告', 'ＡＢＣ')).toBe(true);
    expect(hit('12月の予定', '１２')).toBe(true);
  });

  it('半角カナで打っても全角カナの題名が出る(逆も)', () => {
    expect(hit('ハンカク', 'ﾊﾝｶｸ')).toBe(true);
    expect(hit('ﾘﾝｺﾞ', 'リンゴ')).toBe(true);
  });

  it('Mac の結合濁点の題名を、普通に打った「が」で探せる(逆も)', () => {
    expect(hit(`${KA_COMBINING}く`, 'がく')).toBe(true);
    expect(hit('がく', `${KA_COMBINING}く`)).toBe(true);
  });

  it('🔴 「りんご」で「リンゴ」は出ない(区別を残す)', () => {
    expect(hit('リンゴの木', 'りんご')).toBe(false);
    expect(hit('りんごの木', 'リンゴ')).toBe(false);
    expect(hit('りんごの木', 'りんご')).toBe(true);
  });

  it('全角の空白で前後に挟んで打っても、前後が落ちる', () => {
    expect(normalizeQuery('　abc　')).toBe('abc');
  });

  it('題名の文字列そのものは変わらない(比べるときだけ揃える)', () => {
    const title = 'ＡＢＣ報告';
    hit(title, 'abc');
    expect(title).toBe('ＡＢＣ報告');
  });
});

describe('タグの突き合わせ(173)', () => {
  it('全角半角・濁点の持ち方・大小が違うだけのタグは同じタグ', () => {
    expect(sameTag('ＡＢＣ', 'abc')).toBe(true);
    expect(sameTag(`${KA_COMBINING}く`, 'がく')).toBe(true);
    expect(sameTag('ﾊﾝｶｸ', 'ハンカク')).toBe(true);
  });

  it('🔴 ひらがなとカタカナは別のタグ', () => {
    expect(sameTag('りんご', 'リンゴ')).toBe(false);
  });

  it('frontmatter に同じ見た目のタグが 2 つ書かれていても 1 つに畳まれ、先に書いた綴りが残る', () => {
    const body = `---\ntags: [ＡＢＣ, abc, ${KA_COMBINING}く, がく]\n---\n本文`;
    expect(readTags(body)).toEqual(['ＡＢＣ', `${KA_COMBINING}く`]);
  });

  it('本文中のタグ行と文書タグも同じ鍵で畳まれる(collectEntryTags)', () => {
    const body = `---\ntags: [ＡＢＣ]\n---\n本文`;
    expect(collectEntryTags(body).all).toEqual(['ＡＢＣ']);
  });

  it('タグの色の鍵と集計の組も、同じ鍵(tagFoldKey)を通る', () => {
    expect(tagColorKey('ＡＢＣ')).toBe(tagColorKey('abc'));
    expect(tagColorKey(`${KA_COMBINING}く`)).toBe(tagFoldKey('がく'));
    expect(tagColorKey('りんご')).not.toBe(tagColorKey('リンゴ'));
    const scan = createQueryScan(TAGS_KEY);
    scan.feed([
      { lid: 'a', head: '---\ntags: [ＡＢＣ]\n---\n' },
      { lid: 'b', head: '---\ntags: [abc]\n---\n' },
      { lid: 'c', head: '---\ntags: [りんご]\n---\n' },
      { lid: 'd', head: '---\ntags: [リンゴ]\n---\n' },
    ]);
    const groups = scan.finish().groups!.groups;
    const abc = groups.find((g) => g.value === 'ＡＢＣ');
    expect(abc?.total, '全角と半角の組が 1 つにまとまっていない').toBe(2);
    expect(groups.length, 'ABC 1 組 + りんご 1 組 + リンゴ 1 組').toBe(3);
  });

  it('115-6 / 129: 大小だけ違う名前への付け替えは、書き換える(外す → 付ける)', () => {
    const body = '---\ntags: [foo]\n---\n本文';
    const removed = applyTagsToBody(body, ['foo'], 'remove');
    expect(removed.body).not.toBeNull();
    const added = applyTagsToBody(removed.body!, ['Foo'], 'add');
    expect(readTags(added.body!)).toEqual(['Foo']);
  });
});

describe('タグの末尾の句読点(174)', () => {
  it('読点・句点・カンマ・ピリオドを外して読む(全角のカンマとピリオドも)', () => {
    for (const tail of ['、', '。', ',', '.', '，', '．', '。。']) {
      expect(normalizeTag(`請求書${tail}`), `末尾 ${tail}`).toBe('請求書');
    }
  });

  it('途中の `.` は名前の一部', () => {
    expect(normalizeTag('v1.2')).toBe('v1.2');
  });

  it('frontmatter の配列に句読点つきで書いてあっても、句読点なしの同じタグに畳まれる', () => {
    expect(readTags('---\ntags: [請求書。, 請求書]\n---\n')).toEqual(['請求書']);
  });

  it('打つ欄(splitTags)でも同じ', () => {
    expect(splitTags('#請求書。 #家事、')).toEqual(['請求書', '家事']);
  });
});

describe('取り込みのタグの key(175)', () => {
  const tagsOf = (key: string, value = '[買い物, 家事]'): string[] =>
    readTags(`---\n${key}: ${value}\n---\n本文`);

  it('Tags / tag / keywords / 大文字の TAGS を読む', () => {
    for (const key of ['Tags', 'tag', 'keywords', 'TAGS', 'Keywords']) {
      expect(tagsOf(key), key).toEqual(['買い物', '家事']);
    }
  });

  it('井桁の並びも別名の key で 0 個にならない', () => {
    expect(tagsOf('Tags', '#買い物 #家事')).toEqual(['買い物', '家事']);
  });

  it('`tags` があれば別名は読まない(合算しない)。対照群: `tags` だけのときは読める', () => {
    const both = '---\nkeywords: [別名]\ntags: [正]\n---\n';
    expect(readTags(both)).toEqual(['正']);
    expect(readTags('---\ntags: [正]\n---\n')).toEqual(['正']);
  });

  it('無関係な key(`smart-tags` など)は読まない', () => {
    expect(readTags('---\nsmart-tags: [a]\n---\n')).toEqual([]);
  });

  it('取り込みの読み取り(readPlainMarkdown)は本文を 1 字も変えない', () => {
    const text = '---\nTags: [買い物]\n---\n# 題\n';
    expect(readPlainMarkdown(text, 'a.md').body).toBe(text);
  });

  it('🔴 別名の行から最後の 1 つを外しても、外したタグが戻らない(別名の行を消して書く)', () => {
    const body = '---\nTags: [買い物]\n---\n本文';
    const r = applyTagsToBody(body, ['買い物'], 'remove');
    expect(r.body).not.toBeNull();
    expect(readTags(r.body!)).toEqual([]);
    expect(r.body).not.toContain('Tags');
  });

  it('別名の行に 1 つ足すと、既存のタグを落とさず `tags:` にまとまる', () => {
    const body = '---\nkeywords: [買い物]\n---\n本文';
    const r = applyTagsToBody(body, ['家事'], 'add');
    expect(readTags(r.body!)).toEqual(['買い物', '家事']);
    expect(r.body).not.toContain('keywords');
  });
});

describe('更新日の引き継ぎ(176)', () => {
  const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

  it('lastModified を DB の刻み(UTC)にする', () => {
    expect(stampOfFileTime(Date.UTC(2023, 0, 2, 3, 4, 5), NOW)).toBe('2023-01-02 03:04:05');
  });

  it('0・数でない値・未来は null(「いま」に倒す)', () => {
    expect(stampOfFileTime(0, NOW)).toBeNull();
    expect(stampOfFileTime(Number.NaN, NOW)).toBeNull();
    expect(stampOfFileTime(NOW + 1, NOW)).toBeNull();
    expect(stampOfFileTime(undefined as unknown as number, NOW)).toBeNull();
  });

  it('取り込みの書込に、file の更新日が updatedAt として載る(作成日は載せない)', async () => {
    const written: EntryUpsert[] = [];
    const d = new Dispatcher();
    d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [], relations: [] });
    let n = 0;
    const deps: MarkdownImportDeps = {
      orderBase: () => 0,
      genLid: () => `lid-${++n}`,
      bulkUpsertEntries: async (es) => void written.push(...es),
      reload: async () => {},
    };
    const old = new Date(Date.UTC(2020, 5, 7, 8, 9, 10));
    const file = new File(['# 古いメモ\n'], 'old.md', { lastModified: old.getTime() });
    const done = await importMarkdownFiles(d, deps, [file]);
    expect(done).toBe(1);
    expect(written[0]!.updatedAt).toBe('2020-06-07 08:09:10');
    expect(written[0]!.createdAt ?? null).toBeNull();
  });
});
