/** #1163 依頼 346(推薦 A): 末尾が箇条書きで、足す行も箇条書きなら、空行を挟まない(既存の項目の行間を変えない)。 */
import { describe, expect, it } from 'vitest';
import { appendBlock, continuesList } from '../../src/features/markdown/text-ops';
import { appendIntoSection } from '../../src/features/markdown/append-target';

describe('箇条書きの続きに空行を挟まない(依頼 346)', () => {
  it('🔴 末尾への追記: 箇条書き同士は 1 行で続く', () => {
    expect(appendBlock('- [ ] 買う\n- [x] 払う\n', null, '- 作業 10:00〜10:25')).toBe(
      '- [ ] 買う\n- [x] 払う\n- 作業 10:00〜10:25\n',
    );
    expect(appendBlock('1. 一\n2. 二\n\n\n', null, '3. 三')).toBe('1. 一\n2. 二\n3. 三\n');
  });

  it('⚠ 対照群 ── 片方が箇条書きでなければ、今までどおり空行を挟む', () => {
    expect(appendBlock('段落\n', null, '- 作業')).toBe('段落\n\n- 作業\n');
    expect(appendBlock('- 項目\n', null, '段落')).toBe('- 項目\n\n段落\n');
    // 見出しを付ける回(ログ)は節を分けるので挟む
    expect(appendBlock('- 項目\n', '## 10:00', '- 作業')).toBe('- 項目\n\n## 10:00\n\n- 作業\n');
  });

  it('判定は行頭の印(- * + 番号)で見る', () => {
    expect(continuesList('前\n* あ', '+ い')).toBe(true);
    expect(continuesList('前\n1) あ', '- い')).toBe(true);
    expect(continuesList('前\n-あ', '- い'), '印の後に空白が無いのは箇条書きではない').toBe(false);
    expect(continuesList('', '- い')).toBe(false);
  });

  it('🔴 節への追記: 節の末尾が箇条書きなら空行を挟まず、次の見出しとは空ける', () => {
    const base = '# 作業\n\n- 朝\n- 昼\n\n# メモ\n\nほか\n';
    const out = appendIntoSection(base, '作業', null, '- 夜');
    expect(out).toBe('# 作業\n\n- 朝\n- 昼\n- 夜\n\n# メモ\n\nほか\n');
  });

  it('⚠ 対照群 ── 節の末尾が段落なら、前に空行を挟む', () => {
    const base = '# 作業\n\n朝の段落\n\n# メモ\n';
    expect(appendIntoSection(base, '作業', null, '- 夜')).toBe('# 作業\n\n朝の段落\n\n- 夜\n\n# メモ\n');
  });
});
