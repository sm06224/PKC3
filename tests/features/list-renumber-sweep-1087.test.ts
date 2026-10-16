import { describe, expect, it } from 'vitest';
import { renumberLists } from '../../src/features/markdown/list-renumber';

describe('renumberLists: 項目の中身(字下げ行)で数えを切らない (#1087 sweep)', () => {
  it('入れ子の箇条書きを挟んでも続く', () => {
    expect(renumberLists('1. a\n   - sub\n   - sub2\n4. b\n')).toBe('1. a\n   - sub\n   - sub2\n2. b\n');
  });
  it('画像の行を挟んでも続く', () => {
    expect(renumberLists('1. a\n   ![img](x.png)\n2. b\n5. c\n')).toBe('1. a\n   ![img](x.png)\n2. b\n3. c\n');
  });
  it('字下げ付きの fence を挟んでも続く(中は触らない)', () => {
    expect(renumberLists('1. a\n   ```\n   7. x\n   ```\n4. b\n')).toBe('1. a\n   ```\n   7. x\n   ```\n2. b\n');
  });
  it('入れ子の番号付きは独立に数える', () => {
    expect(renumberLists('1. a\n   5. x\n   9. y\n3. b\n')).toBe('1. a\n   1. x\n   2. y\n2. b\n');
  });
  it('対照群: 字下げの無い段落・記号の違う箇条書き・字下げの無い fence では切れる', () => {
    expect(renumberLists('1. a\n\n段落\n\n4. b\n')).toBe('1. a\n\n段落\n\n1. b\n');
    expect(renumberLists('1. a\n- x\n4. b\n')).toBe('1. a\n- x\n1. b\n');
    expect(renumberLists('1. a\n```\ncode\n```\n4. b\n')).toBe('1. a\n```\ncode\n```\n1. b\n');
  });
});
