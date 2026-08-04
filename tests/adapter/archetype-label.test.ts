/** @vitest-environment happy-dom */
/**
 * P8 段⑲: 種別の**呼び名は 1 本**。
 *
 * 🔴 直す前は `filer.ts` が独自の対応表(`ARCHETYPE_LABELS`)を持っていて、
 * `spreadsheet` だけ **「シート」**、他の全画面(一覧のチップ / 情報ペインの
 * 種類 / 既定 title)とマニュアルは **「表」**だった ── 同じノートが画面に
 * よって別種類に見える。CLAUDE.md「同じ判定が 2 か所に生えたら規則を 1 つに寄せる」。
 *
 * ⚠ 「filer.ts に archetypeLabel の語が在るか」では当てられない ── import した
 *   まま独自表を残せば満たされる。**実際に描いたセルの文字**で突き合わせる。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { archetypeLabel } from '../../src/adapter/ui/render/sidebar';

const ARCHETYPES = ['text', 'textlog', 'spreadsheet', 'folder', 'attachment', 'todo', 'form'];

describe('種別の呼び名', () => {
  it('🔴 呼び名の表が 2 つ生えていない', () => {
    const filer = readFileSync('src/adapter/ui/render/filer.ts', 'utf-8');
    // 空振り防止 ── filer が種別を描いていること自体を先に確かめる
    expect(filer, 'filer が種別を描いていない').toContain('archetypeLabel(');
    for (const a of ARCHETYPES) {
      expect(filer, `filer が「${a}」の呼び名を自前で持っている`).not.toContain(`${a}: '`);
    }
  });

  it('🔴 全 archetype で呼び名が引ける(既定へ落ちない)', () => {
    for (const a of ARCHETYPES) {
      expect(archetypeLabel(a), `「${a}」の呼び名が無い`).not.toBe(a);
    }
    // 知らない種別は素通しする(落とさない)
    expect(archetypeLabel('unknown-kind')).toBe('unknown-kind');
  });

  it('⚠ マニュアルが使う呼び名と一致する(「シート」は使わない)', () => {
    const manual = readFileSync('docs/manual.md', 'utf-8');
    expect(archetypeLabel('spreadsheet')).toBe('表');
    expect(manual, 'マニュアルに「シート」が復活している').not.toContain('シート');
  });
});
