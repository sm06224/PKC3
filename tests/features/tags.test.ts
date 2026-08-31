/**
 * タグ(#182 / 台帳 #180 の A-2)。
 *
 * 🔴 **新しい概念を足さない**設計なので、守るのは「読み取りの規則」と
 * 「押したら探せること」の 2 つ。
 */
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../../src/features/markdown/frontmatter';
import {
  readTags,
  encodeTags,
  decodeTags,
  sameTag,
  normalizeTag,
  splitTags,
  withTag,
  MAX_TAGS,
  MAX_TAG_CHARS,
} from '../../src/features/flavor/tags';

const fm = (yaml: string) => `---\n${yaml}\n---\n本文\n`;

describe('タグの読み取り', () => {
  it('配列で書ける', () => {
    expect(readTags(fm('tags: [買い物, 家事]'))).toEqual(['買い物', '家事']);
  });

  it('🔴 カンマ区切りの文字列でも書ける(記法を減らさない)', () => {
    expect(readTags(fm('tags: 買い物, 家事'))).toEqual(['買い物', '家事']);
  });

  it('1 つだけでも読める', () => {
    expect(readTags(fm('tags: 買い物'))).toEqual(['買い物']);
  });

  it('frontmatter が無ければ空', () => {
    expect(readTags('ただの本文\n')).toEqual([]);
    expect(readTags(fm('title: x'))).toEqual([]);
  });

  it('前後の空白を落とし、内部の連続空白は 1 つに畳む', () => {
    expect(readTags(fm('tags: [  買い  物  ,  家事 ]'))).toEqual(['買い 物', '家事']);
  });

  it('空のタグは落とす', () => {
    expect(readTags(fm('tags: [買い物, , 家事]'))).toEqual(['買い物', '家事']);
  });

  it('🔴 重複は 1 つに(大小無視で突き合わせる)', () => {
    expect(readTags(fm('tags: [Work, work, WORK]'))).toEqual(['Work']);
  });

  it('順序は書いた順を保つ(並べ替えない)', () => {
    expect(readTags(fm('tags: [ん, あ, か]'))).toEqual(['ん', 'あ', 'か']);
  });

  it('長すぎるタグは落とす(事故った本文が一覧を埋めない)', () => {
    const long = 'あ'.repeat(MAX_TAG_CHARS + 1);
    expect(readTags(fm(`tags: [${long}, ok]`))).toEqual(['ok']);
  });

  it('数が多すぎたら上限で切る', () => {
    const many = Array.from({ length: MAX_TAGS + 10 }, (_, i) => `t${i}`);
    expect(readTags(fm(`tags: [${many.join(', ')}]`))).toHaveLength(MAX_TAGS);
  });

  it('sameTag は大小を無視する(表示は原文のまま)', () => {
    expect(sameTag('Work', 'work')).toBe(true);
    expect(sameTag('買い物', '買物')).toBe(false);
  });
});

describe('抽出列への符号化', () => {
  it('🔴 区切りで囲むので、部分一致が誤爆しない', () => {
    const enc = encodeTags(['買い物', '家事']);
    expect(enc).toBe('|買い物|家事|');
    // 「買い物リスト」というタグに「買い物」の丸ごと一致は当たらない
    expect(encodeTags(['買い物リスト']).includes('|買い物|')).toBe(false);
  });

  it('空なら空文字(区切りだけの文字列にしない)', () => {
    expect(encodeTags([])).toBe('');
    expect(decodeTags('')).toEqual([]);
    expect(decodeTags(null)).toEqual([]);
  });

  it('往復する', () => {
    expect(decodeTags(encodeTags(['a', 'b', '日本語']))).toEqual(['a', 'b', '日本語']);
  });

  it('タグに区切り文字が入っていても壊れない', () => {
    expect(decodeTags(encodeTags(['a|b']))).toEqual(['a b']);
  });
});

/**
 * 🔴 **見えている字をそのまま打てば、同じタグになる**(2026-08-29 の動線レビュー)。
 *
 * ⚠ 本文では `#買い物` という札で見えるのに、情報ペインとスマートフォルダの条件では
 *   `買い物` で出る ── そのまま `#買い物` と打つと**別のタグ**が作られていた
 *   (集計では別の組、条件には入らない。書けてしまうので理由も出ない)。
 */
describe('打つ側は井桁を受け止める(#550)', () => {
  it('🔴 「#買い物」と打っても「買い物」と同じタグになる', () => {
    expect(normalizeTag('#買い物')).toBe('買い物');
    expect(sameTag(normalizeTag('#買い物'), '買い物')).toBe(true);
  });

  it('⚠ 対照群: 井桁の無い字はこれまでどおり', () => {
    expect(normalizeTag('  買い物  ')).toBe('買い物');
  });

  it('⚠ 井桁と空白が混じっても同じ', () => {
    expect(normalizeTag('# 買い物')).toBe('買い物');
    expect(normalizeTag('##買い物')).toBe('買い物');
  });

  it('⚠ 途中の井桁は落とさない(名前の一部である)', () => {
    expect(normalizeTag('C#')).toBe('C#');
    expect(normalizeTag('買い物#2')).toBe('買い物#2');
  });

  it('🔑 足すときにも効く(打った字が別のタグにならない)', () => {
    expect(withTag(['買い物'], '#買い物', 'add'), '同じタグを 2 つ作った').toBeNull();
    expect(withTag(['買い物'], '#買い物', 'remove'), '打った字で外せない').toEqual([]);
  });
});

/**
 * 🔴 **1 本の字を、いくつのタグとして読むか**(#637。user 裁定 2026-08-31)。
 *
 * > 「**複数のタグを本文に入れたいけど、どうすればいいか?一つになってしまう**」
 * > 「**#tag1 #tag2 ってすればいいやん**」
 *
 * ⚠ 直す前の実測 ── **同じ字が、場所によって別の個数**になっていた:
 *
 * | `#買い物 #家事` と書いた場所 | 直す前 | 直した後 |
 * |---|---|---|
 * | 本文のタグの行 | 2 個 | 2 個(変えていない) |
 * | 情報ペインの打つ欄 | **1 個**「#買い物 #家事」 | 2 個 |
 * | frontmatter の `tags:` | **0 個**(YAML の行末コメントに刈られた) | 2 個 |
 */
describe('井桁が付いていれば、空白で区切る(#637)', () => {
  it('🔴 `#買い物 #家事` は 2 個', () => {
    expect(splitTags('#買い物 #家事')).toEqual(['買い物', '家事']);
  });

  it('🔴 全角空白でも区切る(日本語で打つと入る)', () => {
    expect(splitTags('#買い物　#家事')).toEqual(['買い物', '家事']);
  });

  /**
   * 🔴 **対照群 ── 井桁が無ければ割らない。**
   * ⚠ 空白入りのタグ名は**事故ではなく意図**である(`readTags` の
   *   「内部の連続空白は 1 つに畳む」/ `bulk-tag.test.ts` の `請求 済` が pin)。
   * ⚠ そのうえ `encodeTags` は索引の `|` を**空白へ変換する**ので、
   *   こちら自身が空白入りの名前を作る側に居る ── 空白で割ると自分の索引を割る。
   */
  it('🔴 対照群: 井桁が無ければ空白では割らない', () => {
    expect(splitTags('買い物 家事')).toEqual(['買い物 家事']);
  });

  it('⚠ 井桁が片方だけなら割らない(並べて書いた形ではない)', () => {
    expect(splitTags('#買い物 家事')).toEqual(['買い物 家事']);
  });

  it('カンマ区切りはこれまでどおり通る(記法を減らさない)', () => {
    expect(splitTags('買い物, 家事')).toEqual(['買い物', '家事']);
  });

  it('井桁とカンマを重ねて書いても、区切りが名前に残らない', () => {
    expect(splitTags('#買い物, #家事')).toEqual(['買い物', '家事']);
    expect(splitTags('#買い物,#家事')).toEqual(['買い物', '家事']);
  });

  it('1 語だけなら井桁を外すだけ', () => {
    expect(splitTags('#買い物')).toEqual(['買い物']);
  });

  it('空の欄は 0 個(押しても撃たない側へ倒す)', () => {
    expect(splitTags('')).toEqual([]);
    expect(splitTags('   ')).toEqual([]);
  });

  it('⚠ 上限と重複はここでも守る(1 度に 12 件書く経路が通る)', () => {
    const many = Array.from({ length: MAX_TAGS + 3 }, (_, i) => `#t${i}`).join(' ');
    expect(splitTags(many)).toHaveLength(MAX_TAGS);
    expect(splitTags('#買い物 #買い物')).toEqual(['買い物']);
    expect(splitTags(`#${'あ'.repeat(MAX_TAG_CHARS + 1)} #ok`)).toEqual(['ok']);
  });
});

/**
 * 🔴 **frontmatter に手で書いた `#` も通る**(#637)。
 *
 * ⚠ 直す前は **0 個**だった ── `stripTrailingComment` が YAML の慣例どおり
 *   「空白 + `#` から先は注釈」として刈っていたためである。
 * 🔑 **刈らない条件は 1 つ:語が全部 `#` で始まり、後ろに字がある。**
 *   だから**注釈はこれまでどおり書ける**(下の対照群)。
 */
describe('frontmatter の tags に井桁で書く(#637)', () => {
  it('🔴 `tags: #買い物 #家事` が 2 個になる', () => {
    expect(readTags(fm('tags: #買い物 #家事'))).toEqual(['買い物', '家事']);
  });

  it('🔴 1 つだけでも読める(直す前は 0 個だった)', () => {
    expect(readTags(fm('tags: #買い物'))).toEqual(['買い物']);
  });

  it('🔴 角括弧に入れて書いても読める', () => {
    expect(readTags(fm('tags: [#買い物, #家事]'))).toEqual(['買い物', '家事']);
  });

  it('全角空白で並べても読める', () => {
    expect(readTags(fm('tags: #買い物　#家事'))).toEqual(['買い物', '家事']);
  });

  /**
   * 🔴 **対照群 ── 注釈は注釈のまま。**
   * ⚠ マニュアルは「`---` の中は YAML のコメントとして書けます」と**約束している**
   *   ので、ここが壊れたら約束を破ったことになる。
   */
  it('🔴 対照群: `tags: # 買うものは後で` は注釈のまま(0 個)', () => {
    expect(readTags(fm('tags: # 買うものは後で'))).toEqual([]);
  });

  /**
   * 🔴 **`#` 単独は「ここから注釈」の印である**(変異試験 M7 が SURVIVED で教えた)。
   *
   * ⚠ 1 つ上の対照群では**この規則が効いていなかった** ── `買うものは後で` が
   *   `#` で始まらないので、`#` を語に数えても数えなくても同じ結果になる。
   * 🔑 **効くのは「`#` の後ろの語も井桁で始まる」形だけ**である ──
   *   `# #買い物` は「『#買い物』と書いた注釈」であって、タグではない。
   */
  it('🔴 対照群: `tags: # #買い物` は注釈のまま(0 個)', () => {
    expect(readTags(fm('tags: # #買い物'))).toEqual([]);
  });

  it('🔴 対照群: 値の後ろの注釈は刈る', () => {
    expect(readTags(fm('tags: 買い物 # あとで足す'))).toEqual(['買い物']);
    expect(readTags(fm('tags: [買い物] # メモ'))).toEqual(['買い物']);
  });

  /**
   * 🔴 **対照群: `tags` 以外の key には効かせない。**
   * ⚠ `title: #TODO` を値に変えると、注釈のつもりで書いた字が題名として画面へ出る。
   */
  it('🔴 対照群: 他の key では井桁は注釈のまま', () => {
    expect(parseFrontmatter(fm('title: #TODO')).meta['title']).toEqual([]);
  });
});
