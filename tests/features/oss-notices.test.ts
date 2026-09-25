/**
 * 🔴 **使っている OSS の表記(#948)**。
 *
 * ## 守る主張
 *
 * ① 純粋関数の中身(開発者行・件数の字・全文が無いときの断り書き)
 * ② 🔴 **`package.json` の `dependencies` の全部が、焼いた一覧に載っている**
 *    (手で並べた一覧と突き合わせない ── `package.json` を読んで**全数**で見る)
 * ③ 事実だけを言う(法律の断定を書かない ── 少なくとも「〜してよい」を含まない)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import OSS_NOTICES from 'virtual:pkc-oss-notices';
import { VENDORED_FONT_SOURCES } from '../../build/oss-notices-plugin';
import {
  OSS_AI_COAUTHOR,
  OSS_DEVELOPER,
  OSS_SCOPE_NOTE,
  OSS_SOURCE_URL,
  ossDeveloperLine,
  ossNoticesLabel,
  ossNoticesMissingText,
} from '../../src/features/oss-notices/oss-notices';

describe('OSS 表記(純粋関数)', () => {
  it('開発者名と AI との共作が 1 行に入る(裁定どおりの文面)', () => {
    const line = ossDeveloperLine();
    expect(line).toContain(OSS_DEVELOPER);
    expect(line).toContain(OSS_AI_COAUTHOR);
    // ⚠ 実名は出さない(裁定)── 開発者名の行に "sm06224" 以外の固有名を持ち込まない
    expect(line).toBe(`開発: ${OSS_DEVELOPER} ── ${OSS_AI_COAUTHOR}`);
  });

  it('GitHub への導線は裁定済みの URL そのまま', () => {
    expect(OSS_SOURCE_URL).toBe('https://github.com/sm06224/PKC3');
  });

  it('見出しの件数は「切るのはここ 1 か所」── 渡した配列の長さをそのまま出す', () => {
    expect(ossNoticesLabel([])).toBe('使っているオープンソース(0 件)');
    expect(ossNoticesLabel([{ name: 'a', license: 'MIT', text: null }])).toBe(
      '使っているオープンソース(1 件)',
    );
  });

  it('🔴 全文が無いときの断り書きは、種別だけを言う(捏造しない)', () => {
    const msg = ossNoticesMissingText('MIT');
    expect(msg).toContain('MIT');
    expect(msg).toContain('同梱されていません');
    // ⚠ 法律の断定を書かない ── 「してよい」「できる」のような許諾の言い切りを含まない
    expect(msg, '許諾の断定が書かれている').not.toMatch(/してよ|できます|自由に/u);
  });

  it('⚠ 対象外の一言(Office / DuckDB の実体)にも許諾の断定が無い', () => {
    expect(OSS_SCOPE_NOTE, '許諾の断定が書かれている').not.toMatch(/してよ|できます|自由に/u);
  });
});

describe('🔴 dependencies の全部が焼いた一覧に載っている(#948 の門の本体)', () => {
  /**
   * ⚠ **手で並べた一覧と突き合わせない**。`package.json` を直接読んで、
   * `OSS_NOTICES`(= `virtual:pkc-oss-notices`。build 側が焼いた実体)と
   * **集合として**一致するかを見る。
   *
   * 🔑 依存を 1 つ増やしても(package.json を直せば)この test の右辺が動くので、
   * 追随を忘れて挙動だけが変わると**ここが落ちる**(実際に §「依存を 1 つ増やして
   * 落ちることを確かめる」を変異試験で確かめてある ── 下の report を参照)。
   *
   * 🔴 **例外が 1 つある**(#1054 段①)── `@phosphor-icons/web` は
   * `devDependencies`(書体を焼くためだけの道具)なのに、glyph データが
   * 配布物へ入るので `build/oss-notices-plugin.ts` の `VENDORED_FONT_SOURCES` が
   * 名指しで足す。⚠ **ここでも名指しで足す**(2 つ目の一覧にしない ──
   * `build` 側の定数をそのまま import して使う)。
   */
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const declared = [...Object.keys(pkg.dependencies ?? {}), ...VENDORED_FONT_SOURCES].sort();

  it('件数が一致する', () => {
    // ⚠ 空振り防止 ── 前提(dependencies が空でない)を確かめてから比べる
    expect(declared.length, '前提が崩れている: package.json に dependencies が無い').toBeGreaterThan(0);
    expect(OSS_NOTICES.length, '焼いた一覧の件数が package.json と食い違う').toBe(declared.length);
  });

  it('🔴 名前の集合が一致する(件数が合うだけでは、入れ違いを見逃す)', () => {
    const got = [...OSS_NOTICES].map((n) => n.name).sort();
    expect(got, '焼いた一覧の名前の集合が package.json と食い違う').toEqual(declared);
  });

  it('全部が SPDX の種別を持つ(空文字ではない)', () => {
    for (const n of OSS_NOTICES) {
      expect(n.license.trim(), `${n.name} の license が空`).not.toBe('');
    }
  });

  it('全文は「文字列」か「無い(null)」のどちらかで、空文字ではない', () => {
    for (const n of OSS_NOTICES) {
      if (n.text === null) continue;
      expect(n.text.length, `${n.name} の全文が空文字`).toBeGreaterThan(0);
    }
  });

  /**
   * 🔴 **種別が「実物の package.json」から来ていることを見る**(空でないだけでは、
   * 「全部 MIT を返す」ような取り違えを見逃す)。
   */
  it('種別は実物の package.json のとおり(katex=MIT / sqlite-wasm=Apache-2.0)', () => {
    const byName = new Map(OSS_NOTICES.map((n) => [n.name, n.license]));
    expect(byName.get('katex')).toBe('MIT');
    expect(byName.get('@sqlite.org/sqlite-wasm')).toBe('Apache-2.0');
  });

  /**
   * 🔴 **全文の有無が「実物」から来ていることを見る**(実測 2026-09-15:
   * duckdb-wasm / sqlite-wasm は同梱していない。katex は同梱している)。
   */
  it('全文の有無は実物のとおり(katex には在り、sqlite-wasm には無い)', () => {
    const byName = new Map(OSS_NOTICES.map((n) => [n.name, n.text]));
    expect(byName.get('katex'), 'katex は LICENSE を同梱しているはず').not.toBeNull();
    expect(byName.get('@sqlite.org/sqlite-wasm'), 'sqlite-wasm は同梱していないはず').toBeNull();
  });
});
