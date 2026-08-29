/**
 * 🔴 **1 ノートが持つタグ**(#550 段②。裁定 B ── 索引だけ)。
 *
 * 🔑 ここで守る主張は 3 つ:
 * 1. **文書タグ + 本文中タグ**が揃い、`sameTag`(大小無視)で**重複排除**される
 * 2. 🔴 **走査の側(`tagsForMatch`)と保存直後の側(`collectEntryTags`)が同じ答えを返す**
 *    ── CLAUDE.md §7「同じ問いに答える口が 2 つあると、片方だけ壊しても届かない」。
 *    ⚠ この 2 つは**別の材料**から作る(片方は先頭 + 索引、もう片方は本文丸ごと)ので、
 *    「同じ関数を 2 度呼ぶだけ」の空 parity にはならない。
 * 3. **まだ集約していない行**(`null`)は文書タグだけで当たる ── 壊れではなく遅れ
 */
import { describe, expect, it } from 'vitest';
import { bodyTags, collectEntryTags, tagsForMatch } from '../../src/features/flavor/entry-tags';
import { decodeTags, encodeTags, MAX_TAGS } from '../../src/features/flavor/tags';
import { FRONTMATTER_SCAN_CHARS } from '../../src/features/query/group-by';

const FM = (tags: string) => `---\ntags: [${tags}]\n---\n`;

describe('collectEntryTags(#550 段②)', () => {
  it('🔴 文書タグと本文中タグの両方が `all` に出る', () => {
    const v = collectEntryTags(`${FM('請求')}# 見出し\n\n#買い物 #家事\n`);
    expect(v.doc).toEqual(['請求']);
    expect(v.inBody).toEqual(['買い物', '家事']);
    expect(v.all).toEqual(['請求', '買い物', '家事']);
  });

  it('🔴 本文中の重複は保存時に畳まれる(user の字「重複排除して集約」)', () => {
    const v = collectEntryTags('# a\n\n#請求\n\n# b\n\n#請求 #買い物\n');
    expect(v.inBody, '重複が畳まれていない').toEqual(['請求', '買い物']);
    // ⚠ **出現そのものは捨てない** ── どの見出しで付いたかが user の要件である
    expect(v.uses.map((u) => u.heading.join('/'))).toEqual(['a', 'b', 'b']);
  });

  it('⚠ 大小違いは同じタグ(初出の綴りが残る)', () => {
    const v = collectEntryTags('#Bill\n\n#bill\n');
    expect(v.inBody).toEqual(['Bill']);
  });

  it('⚠ 文書タグと同じものが本文にあっても、二重に出ない', () => {
    const v = collectEntryTags(`${FM('請求')}#請求\n`);
    expect(v.all).toEqual(['請求']);
  });

  it('⚠ 上限を超えたぶんは足さない(黙って古いほうを落とさない)', () => {
    const many = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `#t${i}x`).join('\n\n');
    const v = collectEntryTags(many);
    expect(v.inBody).toHaveLength(MAX_TAGS);
    expect(v.inBody[0], '古いほうが落ちている').toBe('t0x');
  });

  /**
   * 🔴 **parity** ── 走査の側と保存直後の側が同じ答えを返す。
   *
   * ⚠ 材料が違うことを**その場で assert する**(前提が崩れたら「一致しなかった」
   *   ではなく「前提が崩れている」で落ちるように ── CLAUDE.md §1)。
   */
  describe('🔴 走査の側と保存直後の側が食い違わない', () => {
    const CASES: ReadonlyArray<readonly [string, string]> = [
      ['文書タグだけ', `${FM('請求, 未処理')}本文\n`],
      ['本文中タグだけ', '# 章\n\n#買い物 #家事\n'],
      ['両方', `${FM('請求')}# 章\n\n#買い物\n`],
      ['どちらも無い', '# 章\n\nただの本文\n'],
      ['同じタグが両方にある', `${FM('請求')}#請求\n`],
      ['fence の中は数えない', '```\n#にせもの\n```\n\n#本物\n'],
      [
        '本文の末尾に在る(先頭だけでは絶対に見えない)',
        `${FM('請求')}${'あ'.repeat(FRONTMATTER_SCAN_CHARS + 100)}\n\n#末尾\n`,
      ],
    ];
    for (const [name, body] of CASES) {
      it(name, () => {
        const head = body.slice(0, FRONTMATTER_SCAN_CHARS);
        /**
         * ⚠ **前提**: 走査の側が受け取るのは「先頭だけ + 索引」である。
         *   最後の例では先頭に本文中タグが 1 つも無い ── これが崩れると
         *   parity は「たまたま同じ本文を 2 度読んだだけ」になる。
         */
        expect(
          bodyTags(head).length === 0 || body.length <= FRONTMATTER_SCAN_CHARS,
          '前提が崩れている(先頭にも本文中タグが在るので、索引を通らずに当たりうる)',
        ).toBe(true);
        // ⚠ 索引は **encode → decode を往復させる**(列に入る形そのもので突き合わせる)
        const indexed = decodeTags(encodeTags(bodyTags(body)));
        expect(tagsForMatch(head, indexed)).toEqual(collectEntryTags(body).all);
      });
    }
  });

  it('🔴 まだ集約していない行(null)は、文書タグだけで当たる', () => {
    const body = `${FM('請求')}#買い物\n`;
    expect(tagsForMatch(body, null), '索引が無いのに本文中タグが出ている').toEqual(['請求']);
    // ⚠ **対照群** ── 索引が在れば出る(上の行が「常に空」で通っていないこと)
    expect(tagsForMatch(body, bodyTags(body))).toEqual(['請求', '買い物']);
  });

  it('⚠ 索引が空文字(集約した結果 0 件)と null は別物である', () => {
    expect(decodeTags(encodeTags([]))).toEqual([]);
    expect(tagsForMatch(FM('請求'), [])).toEqual(['請求']);
  });
});
