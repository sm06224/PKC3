/**
 * 🔴 **用語の総直しの記録(`docs/development/ui-terms-rename-2026-10.md`)が、門(`BANNED_TERMS`)と
 * 食い違わない**(2026-10-06)。
 *
 * ⚠ 守るのは「使わない語の表を手で書くと、門に足した語が doc に載らず、doc にだけ在る語が
 *   門に無い、が起きる」こと。初稿は手書きの表で、門に在る 50 語が載らず、表にだけ在る語が 7 つあった。
 * 🔑 だから表は**手で書かない** ── `BANNED_TERMS` から機械で作り、doc の
 *   `<!-- ui-terms:generated:start -->` 〜 `<!-- ui-terms:generated:end -->` の間と**一字一句**比べる。
 *   門に語を足した・言い換え先を直したときは、次のコマンドで doc を作り直す:
 *   `UPDATE_UI_TERMS_DOC=1 npx vitest run tests/features/ui-terms-doc.test.ts`
 * ⚠ 「門には無いが直した語」の表(手書き)は、門に在る語と**重ならない**ことだけを見る
 *   (重なる = 門へ足した語が手書きの表に残っている)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BANNED_TERMS } from '../../src/features/ui-terms';

const DOC_PATH = 'docs/development/ui-terms-rename-2026-10.md';
const START = '<!-- ui-terms:generated:start -->';
const END = '<!-- ui-terms:generated:end -->';

/** 種類の並び(`BannedTerm['reason']` の宣言順)。表はこの順で、種類ごとに 1 枚。 */
const REASONS = ['造語', '評価語・脅し語', '英語の素通し', '飾り記号', '表記の統一'] as const;

/** 表の 1 マス。⚠ 表の区切り `|` は `\|` にする。 */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/** 門から作る表。⚠ ここだけが正本 ── doc の中身は、この関数の出力と等しくなければならない。 */
export function renderGenerated(): string {
  const out: string[] = [];
  for (const reason of REASONS) {
    const rows = BANNED_TERMS.filter((t) => t.reason === reason);
    if (rows.length === 0) continue;
    out.push(`### ${reason}(${String(rows.length)} 語)`, '', '| 使わない語 | 言い換え先 | 除く語(実在の複合語) |', '|---|---|---|');
    for (const t of rows) {
      const ex = t.excludes.length === 0 ? '' : t.excludes.map((e) => `\`${cell(e)}\``).join(' ');
      out.push(`| \`${cell(t.banned)}\` | ${cell(t.instead)} | ${ex} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

function between(doc: string): string | null {
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  if (a < 0 || b < a) return null;
  return doc.slice(a + START.length, b).trim();
}

describe('用語の総直しの記録 ── 門(BANNED_TERMS)から機械で作った表と一致する', () => {
  const doc = readFileSync(DOC_PATH, 'utf-8');

  it('空振り防止:印が 1 組あり、門に語がある', () => {
    expect(between(doc), '生成範囲の印(start / end)が doc に無い').not.toBeNull();
    expect(BANNED_TERMS.length).toBeGreaterThan(100);
    // 種類の一覧が `BannedTerm['reason']` と食い違うと、表に載らない語が出る
    expect(
      BANNED_TERMS.filter((t) => !(REASONS as readonly string[]).includes(t.reason)),
      '種類の一覧(REASONS)に無い種類が門に増えた',
    ).toEqual([]);
  });

  it('🔴 生成範囲が、門から作った表と一字一句同じ(違うときは UPDATE_UI_TERMS_DOC=1 で作り直す)', () => {
    const want = renderGenerated();
    if (process.env['UPDATE_UI_TERMS_DOC'] === '1') {
      const a = doc.indexOf(START) + START.length;
      const b = doc.indexOf(END);
      writeFileSync(DOC_PATH, `${doc.slice(0, a)}\n\n${want}\n\n${doc.slice(b)}`, 'utf-8');
      return;
    }
    expect(between(doc), 'doc の表が門と食い違っている(UPDATE_UI_TERMS_DOC=1 で作り直す)').toBe(want);
  });

  it('🔴 表の使わない語の集合 = 門の語の集合(件数も同じ)', () => {
    const block = between(doc) ?? '';
    const words = [...block.matchAll(/^\| `((?:[^`\\]|\\.)+)` \|/gm)].map((m) =>
      (m[1] as string).replace(/\\\|/g, '|'),
    );
    expect(words.length, '表の語を 1 つも拾えていない(空振り)').toBeGreaterThan(100);
    expect([...words].sort()).toEqual(BANNED_TERMS.map((t) => t.banned).sort());
  });

  it('🔴 「門には無いが直した語」の表と、門の語が重ならない', () => {
    const start = doc.indexOf('## 門には無いが直した語');
    expect(start, '「門には無いが直した語」の節が無い').toBeGreaterThan(0);
    const rest = doc.slice(start);
    const next = rest.indexOf('\n## ', 3);
    const section = next < 0 ? rest : rest.slice(0, next);
    const olds = section
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| 旧') && !l.startsWith('|---'))
      .map((l) => (l.split('|')[1] ?? '').trim());
    expect(olds.length, '手書きの表の行を拾えていない(空振り)').toBeGreaterThan(10);
    const gate = new Set(BANNED_TERMS.map((t) => t.banned));
    expect(
      olds.filter((w) => gate.has(w)),
      '門へ足した語が「門には無い」の表に残っている ── 表から消す',
    ).toEqual([]);
  });

  it('self-test:表の 1 マスの `|` は逃がす', () => {
    expect(cell('入 | 切')).toBe('入 \\| 切');
  });
});
