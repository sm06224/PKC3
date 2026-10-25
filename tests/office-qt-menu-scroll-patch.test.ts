/** @vitest-environment node */
/**
 * `build/office-wasm/patch-lo-qt-menu-scroll.py` を検める(#126 / #774 の**直し**)。
 *
 * 🔴 **直す物**: 書式(Format)など縦に長いメニューが 2 列に割れて下端で切れる。メニューは VCL ではなく Qt の `QMenu`
 * (`QtMenu.cxx`)で、wasm の style は `SH_Menu_Scrollable` が偽 = 画面に収まらないと列を足して割る。
 * 直しは 2 か所: `SH_Menu_Scrollable` だけ真にする `QProxyStyle`(file scope)と、`QtMenu` が作る全部の `QMenu` が通る
 * `connectHelpSignalSlots` の末尾でそれを付ける。
 *
 * ⚠ 見るのは 5 つ: ① 錨が上流の原文(抜粋)に当たる / 1 つ外しても落ちて file は不変 / 二重当ては落ちて不変
 * ② 足した行は全部印を含み、原文の行は 1 行も書き換えない ③ 直しの中身(`SH_Menu_Scrollable` を真にし、他は元の style へ渡す /
 * 親を付ける / 全部の QMenu が通る関数に付ける)④ 他の LO patch と錨が重ならない ⑤ workflow の本数がこの 1 本を数えている
 *
 * 🔴 **言えないこと**: 当てた後の C++ が Qt / LO の header でコンパイルできること、焼いて 1 列 + 矢印になること
 * (`dialog-crash-probe.mjs` の `format-menu` suite の画像で見る)。
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SCRIPT = 'build/office-wasm/patch-lo-qt-menu-scroll.py';
const REL = 'vcl/qt5/QtMenu.cxx';
const MARK = 'PKC3-MENUSCROLL';
const EXCERPT = readFileSync('tests/fixtures/office-lo/QtMenu-scroll.excerpt.cxx', 'utf-8');

function tree(body: string = EXCERPT) {
  const dir = mkdtempSync(join(tmpdir(), 'pkc3-menuscroll-'));
  mkdirSync(dirname(join(dir, REL)), { recursive: true });
  writeFileSync(join(dir, REL), body, 'utf-8');
  return {
    dir,
    read: () => readFileSync(join(dir, REL), 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
function run(dir: string): { code: number; out: string } {
  const r = spawnSync('python3', [SCRIPT, dir], { encoding: 'utf-8', stdio: 'pipe' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
const count = (text: string, needle: string): number => text.split(needle).length - 1;

function patched(): string {
  const t = tree();
  try {
    expect(run(t.dir).code).toBe(0);
    return t.read();
  } finally {
    t.cleanup();
  }
}

describe('#126 の直し(qt-menu-scroll)── 当て方', () => {
  it('🔴 上流の原文(抜粋)に当たり、印が入る', () => {
    const out = patched();
    expect(count(out, 'class PkcScrollableMenuStyle')).toBe(1);
    expect(count(out, '#include <QtWidgets/QProxyStyle> // PKC3-MENUSCROLL')).toBe(1);
    expect(count(out, 'pMenu->setStyle(pPkcStyle); // PKC3-MENUSCROLL')).toBe(1);
  });

  it('🔴 二重当ては落ちて、file は 1 バイトも変わらない', () => {
    const t = tree();
    try {
      expect(run(t.dir).code).toBe(0);
      const once = t.read();
      const second = run(t.dir);
      expect(second.code).toBe(1);
      expect(second.out).toContain('二重当て');
      expect(t.read()).toBe(once);
    } finally {
      t.cleanup();
    }
  });

  it('⚠ 錨が 1 つ外れたら落ちて、何も書かない(半分だけ当たらない)', () => {
    const cases = [
      '#include <QtWidgets/QStyle>\n',
      'const QString gButtonGroupKey("QtMenu::ButtonGroup");\n',
      '    pMenu->setToolTipsVisible(true);\n',
    ];
    for (const a of cases) {
      expect(EXCERPT, `抜粋に錨が無い: ${a}`).toContain(a);
      const broken = EXCERPT.replace(a, '');
      const t = tree(broken);
      try {
        const r = run(t.dir);
        expect(r.code, a).toBe(1);
        expect(t.read(), a).toBe(broken);
      } finally {
        t.cleanup();
      }
    }
  });

  it('⚠ 錨が 2 件ある(上流が重複した)ときも落ちる', () => {
    const doubled = `${EXCERPT}\n${EXCERPT}`;
    const t = tree(doubled);
    try {
      expect(run(t.dir).code).toBe(1);
      expect(t.read()).toBe(doubled);
    } finally {
      t.cleanup();
    }
  });
});

describe('#126 の直し(qt-menu-scroll)── 当てた結果', () => {
  it('🔑 足した行は全部印を含み、印の行を除くと原文と一致する(足すだけ)', () => {
    const out = patched();
    // 空行は足した塊の前後で増減しうるので数えない(原文の「字のある行」が 1 行も消えていないことを見る)
    const lines = (t: string) => t.split('\n').filter((l) => l.trim() !== '');
    const restored = lines(out).filter((l) => !l.includes(MARK));
    expect(restored).toEqual(lines(EXCERPT));
  });

  it('🔴 style は SH_Menu_Scrollable だけ真にして、他は元の style へ渡す', () => {
    const out = patched();
    const at = out.indexOf('class PkcScrollableMenuStyle');
    const body = out.slice(at, out.indexOf('};', at));
    expect(body).toContain('public QProxyStyle');
    expect(body).toMatch(/if \(eHint == SH_Menu_Scrollable\)[\s\S]*return 1;/);
    expect(body, '他の hint を元の style へ渡していない').toContain('return QProxyStyle::styleHint(eHint, pOption, pWidget, pReturn)');
    expect(body, 'override の署名が Qt の QStyle::styleHint と違う').toContain('QStyleHintReturn* pReturn = nullptr) const override');
  });

  it('🔴 付ける先は全部の QMenu が通る connectHelpSignalSlots の末尾(関数の中・setToolTipsVisible の後)で、親を付ける', () => {
    const out = patched();
    const fn = out.slice(out.indexOf('void QtMenu::connectHelpSignalSlots'));
    expect(fn.indexOf('setToolTipsVisible(true)')).toBeGreaterThan(0);
    expect(fn.indexOf('pMenu->setStyle(pPkcStyle)')).toBeGreaterThan(fn.indexOf('setToolTipsVisible(true)'));
    expect(fn, '親を付けない = style が漏れる').toContain('pPkcStyle->setParent(pMenu)');
    expect(fn.indexOf('pPkcStyle->setParent(pMenu)')).toBeLessThan(fn.indexOf('pMenu->setStyle(pPkcStyle)'));
    expect(fn.trimEnd().endsWith('}')).toBe(true);
  });

  it('⚠ style の class は関数の外(file scope)に在る', () => {
    const out = patched();
    expect(out.indexOf('class PkcScrollableMenuStyle')).toBeLessThan(out.indexOf('void QtMenu::connectHelpSignalSlots'));
  });
});

describe('#126 の直し(qt-menu-scroll)── 他の検査との関係', () => {
  it('🔑 錨が、同じ file を触る他の LO patch と重ならない(当てる順で結果が変わらない)', () => {
    const anchors = [
      '#include <QtWidgets/QStyle>\n',
      'const QString gButtonGroupKey("QtMenu::ButtonGroup");\n',
      "// enable tooltips, Qt doesn't show them for menu entries by default",
    ];
    const others = readdirSync('build/office-wasm')
      .filter((f) => /^patch-.*\.py$/.test(f) && f !== 'patch-lo-qt-menu-scroll.py')
      .filter((f) => readFileSync(join('build/office-wasm', f), 'utf-8').includes(`"${REL}"`));
    expect(others.length, 'QtMenu.cxx を触る他の patch が 0 件 = この検査が何も見ていない').toBeGreaterThan(0);
    for (const f of others) {
      const src = readFileSync(join('build/office-wasm', f), 'utf-8');
      for (const a of anchors) expect(src, `${f} が同じ錨を使っている`).not.toContain(a.split('\n')[0]);
    }
  });

  it('🔑 check-patches-on-ref.sh が拾える形(`SRC = "…"`)で当て先を宣言している', () => {
    expect(readFileSync(SCRIPT, 'utf-8')).toMatch(/^SRC\s*=\s*"vcl\/qt5\/QtMenu\.cxx"/m);
  });

  it('🔑 workflow の本数の主張が、この 1 本を数えている(35 → 36)', () => {
    const yml = readFileSync('.github/workflows/office-wasm-build.yml', 'utf-8');
    expect(yml).toMatch(/35 → 36\(2026-10-25\)/);
    expect(yml).toContain('patch-lo-qt-menu-scroll.py');
    expect(yml).toContain('test "$n" -eq 36');
    const files = readdirSync('build/office-wasm').filter((f) => /^patch-.*\.py$/.test(f));
    expect(files.length, '実在する patch-*.py の本数が workflow の -eq と違う').toBe(36);
  });

  it('probe に format-menu suite がある(焼いた後に 1 列 + 矢印を見る口)', () => {
    expect(readFileSync('build/office-wasm/dialog-crash-probe.mjs', 'utf-8')).toContain("'format-menu':");
  });
});
