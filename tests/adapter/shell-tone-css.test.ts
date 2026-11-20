/**
 * 🔴 **ペインは線ではなく地の段差で分ける / 現在地は形 / hover は見える / 見出しに段がある**(#1982 段 2)
 * ── CSS を構文で pin(`button-bars-css.test.ts` と同じ作法。注釈は剥ぐ・`@media` の中は見ない)。
 *
 * ## 守る主張
 * 1. shell の格子は `gap: 0` で、**線色の下地を持たない**(旧い `gap: 1px` + `background: var(--border)`
 *    の升目へ戻さない)。机(shell / 左 / 右)= `--bg`、紙(中央)= `--surface` + `--shadow-sm`
 * 2. **`gap: 1px` + `background: var(--border)` の「線を透かす」作りが、構造を持つ表(カレンダーの月の格子)
 *    以外に残っていない**(全数。許す物は理由つきの既知リスト)
 * 3. 選んでいる行 = 左端の線(`inset 3px` の `--accent`)+ 太字 + 無彩色の地。選んでいるタブ = 下線 + 太字で地なし
 * 4. hover(`--surface-hover`)は全テーマ × 3 つの地(`--bg` / `--surface` / `--surface-2`)の上で**見える濃さ**
 *    (対比 1.06 以上)で、印(`--pkc-mark-bg`)より薄い
 * 5. 本文の見出しは h1 > h2 > h3 の順に**大きさが減り**、上の余白も減る
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decl, stripComments, withoutMedia } from '../helpers/css-blocks';
import { THEMES } from '../../src/adapter/ui/render/theme';

const APP = withoutMedia(stripComments(readFileSync('src/styles/app.css', 'utf-8')));
const TOKENS = stripComments(readFileSync('src/styles/tokens.css', 'utf-8'));

const one = (sel: string): string => {
  const hit = blocksFor(APP, sel);
  expect(hit.length, `${sel} の規則が拾えない`).toBeGreaterThan(0);
  return hit.join('\n');
};

describe('机と紙(#1982 段 2)', () => {
  it('🔴 shell の格子に線色の下地・1px の隙間が無い', () => {
    const body = one("[data-pkc-region='shell']");
    expect(body).toMatch(decl('gap', '0'));
    expect(body).toMatch(decl('background', 'var\\(--bg\\)'));
    expect(body, '線色の下地が戻っている').not.toMatch(decl('background', 'var\\(--border\\)'));
  });

  it('🔴 左右の列は机の地(--bg)、中央は紙(--surface + --shadow-sm)で、中央も線色の下地を持たない', () => {
    expect(blocksFor(APP, "[data-pkc-region='sidebar']").join('\n')).toMatch(decl('background', 'var\\(--bg\\)'));
    expect(blocksFor(APP, "[data-pkc-region='inspector']").join('\n')).toMatch(decl('background', 'var\\(--bg\\)'));
    const center = blocksFor(APP, "[data-pkc-region='center']").join('\n');
    expect(center).toMatch(decl('background', 'var\\(--surface\\)'));
    expect(center).toMatch(decl('box-shadow', 'var\\(--shadow-sm\\)'));
    expect(center).not.toMatch(decl('background', 'var\\(--border\\)'));
    expect(center).not.toMatch(decl('gap', '1px'));
  });

  it('🔴 机と紙は全テーマで別の色(--bg ≠ --surface)', () => {
    for (const t of THEMES) {
      const decls = blocksFor(TOKENS, `:root[data-pkc-theme='${t.id}']`).join(';');
      const bg = /(?:^|;)\s*--bg:\s*(#[0-9a-f]{6})/i.exec(decls)?.[1]?.toLowerCase();
      const surface = /(?:^|;)\s*--surface:\s*(#[0-9a-f]{6})/i.exec(decls)?.[1]?.toLowerCase();
      expect(bg, `${t.id}: --bg が読めない`).toBeTruthy();
      expect(bg, `${t.id}: 机と紙が同じ色(段差が消える)`).not.toBe(surface);
    }
  });

  it('🔴 `gap: 1px` + `background: var(--border)` の「線を透かす」作りが残っていない(既知の構造を除く)', () => {
    // ⚠ 許すのは**表の罫線そのもの**(月の格子 = 日付のセルが線で区切られる構造)だけ。足すときは理由を書く
    const ALLOWED = new Set(["[data-pkc-field='schedule-monthview-body']"]);
    const bad: string[] = [];
    let scanned = 0;
    for (const m of APP.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2] ?? '';
      if (!decl('gap', '1px').test(body)) continue;
      scanned++;
      if (!decl('background', 'var\\(--border\\)').test(body)) continue;
      for (const s of (m[1] ?? '').split(',').map((x) => x.trim().replace(/\s+/g, ' '))) {
        if (!ALLOWED.has(s)) bad.push(s);
      }
    }
    expect(scanned, '走査が壊れている(`gap: 1px` の規則が 0 件)').toBeGreaterThan(0);
    expect(bad, `線を透かす作りが残っている: ${bad.join(' / ')}`).toEqual([]);
  });
});

describe('現在地は形(#1982 段 2)', () => {
  it('🔴 選んでいる行 = 左端の線(inset 3px の --accent)+ 太字 + 無彩色の地(緑の地を使わない)', () => {
    const body = one('[data-pkc-selected]');
    expect(body).toMatch(decl('box-shadow', 'inset 3px 0 0 var\\(--accent\\)'));
    expect(body).toMatch(decl('font-weight', '600'));
    expect(body).toMatch(decl('background', 'var\\(--pkc-selected-bg\\)\\s*!important'));
    expect(body, '現在地に色相の地を使っている').not.toContain('--accent-dim');
  });

  it('🔴 表の行は `<tr>` に影が描けないので、先頭のセルが線を持つ', () => {
    expect(one("[data-pkc-region='filer-table'] tbody tr[data-pkc-selected] td:first-child")).toMatch(
      decl('box-shadow', 'inset 3px 0 0 var\\(--accent\\)'),
    );
  });

  it('🔴 選んでいるタブ(左のタブ / 2 ペインのタブ)= 下線 + 太字で、地を塗らない', () => {
    const tab = one("[data-pkc-region='browse-tabs'] [data-pkc-active]");
    expect(tab).toMatch(decl('box-shadow', 'inset 0 -2px 0 var\\(--accent\\)'));
    expect(tab).toMatch(decl('font-weight', '600'));
    expect(tab).toMatch(decl('background', 'transparent'));
    const dual = one("[data-pkc-region='dual-tab'][data-pkc-active]");
    expect(dual).toMatch(decl('box-shadow', 'inset 0 -2px 0 var\\(--accent\\)'));
    expect(dual).toMatch(decl('font-weight', '600'));
    expect(dual).not.toMatch(decl('background', '.*'));
  });

  it('🔴 PC タブの一覧の行は罫線ではなく隙間で分ける', () => {
    expect(one("[data-pkc-field='pc-list'] > li")).not.toMatch(decl('border-bottom', '.*'));
    expect(one("[data-pkc-field='pc-list']")).toMatch(decl('gap', 'var\\(--s1\\)'));
  });
});

describe('hover が見える(#1982 段 2)', () => {
  const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (rgb: number[]): number => 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
  const ratio = (a: number[], b: number[]): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const tok = (theme: string, name: string): number[] => {
    const decls = blocksFor(TOKENS, `:root[data-pkc-theme='${theme}']`).join(';');
    const m = new RegExp(`(?:^|;)\\s*${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(decls);
    expect(m, `${theme}: ${name} が読めない`).not.toBeNull();
    return hex(m![1]!);
  };
  const mixOver = (fg: number[], base: number[], a: number): number[] => base.map((b, i) => b * (1 - a) + fg[i]! * a);

  it('🔴 --surface-hover は `--fg` を透かす 1 本の定義(全テーマが読む)で、割合は印(18%)より薄く 6% 以上', () => {
    const base = blocksFor(TOKENS, ':root').find((b) => b.includes('--surface-hover:')) ?? '';
    const m = /--surface-hover:\s*color-mix\(in srgb,\s*var\(--fg\)\s*(\d+)%,\s*transparent\)/.exec(base);
    expect(m, '--surface-hover が `--fg` の透かしでない').not.toBeNull();
    const pct = Number(m![1]);
    expect(pct).toBeGreaterThanOrEqual(6);
    expect(pct).toBeLessThan(18);
    for (const t of THEMES) {
      const own = blocksFor(TOKENS, `:root[data-pkc-theme='${t.id}']`).join(';');
      expect(own, `${t.id}: テーマが --surface-hover を上書きしている(1 本の定義から外れる)`).not.toContain('--surface-hover');
    }
  });

  it('🔴 全テーマ × 3 つの地の上で、hover は地と対比 1.06 以上(乗せて見える)', () => {
    const base = blocksFor(TOKENS, ':root').find((b) => b.includes('--surface-hover:')) ?? '';
    const pct = Number(/--surface-hover:[^;]*?(\d+)%/.exec(base)![1]) / 100;
    for (const t of THEMES) {
      const fg = tok(t.id, '--fg');
      for (const name of ['--bg', '--surface', '--surface-2']) {
        const ground = tok(t.id, name);
        const r = ratio(mixOver(fg, ground, pct), ground);
        expect(r, `${t.id}: ${name} の上の hover の対比 ${r.toFixed(3)}`).toBeGreaterThanOrEqual(1.06);
      }
    }
  });

  it('🔴 現在地の線(--accent)は机(--bg)の上でも 3:1 以上(全テーマ)', () => {
    for (const t of THEMES) {
      const r = ratio(tok(t.id, '--accent'), tok(t.id, '--bg'));
      expect(r, `${t.id}: --accent / --bg = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('本文の見出しの段(#1982 段 2)', () => {
  const size = (h: string): number => {
    const m = /font-size:\s*([\d.]+)em/.exec(blocksFor(APP, `.pkc-md-rendered ${h}`).join('\n'));
    expect(m, `${h} の font-size(em)が読めない`).not.toBeNull();
    return Number(m![1]);
  };
  const above = (h: string): number => {
    const m = /margin-block-start:\s*([\d.]+)em/.exec(blocksFor(APP, `.pkc-md-rendered ${h}`).join('\n'));
    expect(m, `${h} の上の余白(em)が読めない`).not.toBeNull();
    return Number(m![1]);
  };

  it('🔴 大きさ: h1 > h2 > h3 > 本文(1em)で、段の差は 0.15em 以上', () => {
    expect(size('h1') - size('h2')).toBeGreaterThanOrEqual(0.15);
    expect(size('h2') - size('h3')).toBeGreaterThanOrEqual(0.15);
    expect(size('h3')).toBeGreaterThan(1.1);
  });

  it('🔴 上の余白: 大きい見出しほど前の塊から離れる(h1 > h2 > h3)', () => {
    expect(above('h1')).toBeGreaterThan(above('h2'));
    expect(above('h2')).toBeGreaterThan(above('h3'));
  });

  it('🔴 h1〜h2 は太字(700)、h3 以下は 600', () => {
    for (const [h, w] of [['h1', '700'], ['h2', '700'], ['h3', '600'], ['h4', '600']] as const) {
      expect(blocksFor(APP, `.pkc-md-rendered ${h}`).join('\n'), h).toMatch(decl('font-weight', w));
    }
  });
});
