/** @vitest-environment node */
/**
 * markdown のリンク宛先走査(P7 段② review M-1 / M-3 で 1 本に寄せた規則)。
 *
 * 🔴 **ここは書出しと取込の共有基盤**なので、片方の都合で緩めると
 * もう片方が静かに壊れる:
 * - 緩めると **書出しが本文を誤って書き換える**(コードブロックの中まで)
 * - 狭めると **取込が「黙って画像が壊れる」参照を数え落とす**
 * どちらの向きにも動かせないよう、両側から縛る。
 */
import { describe, expect, it } from 'vitest';
import { rewriteLinkDests, scanLinks } from '../../src/features/markdown/link-scan';

const dests = (text: string): string[] => scanLinks(text).sites.map((s) => s.dest);
const kinds = (text: string): string[] => scanLinks(text).sites.map((s) => s.kind);

describe('拾う ── 宛先の書かれ方', () => {
  it.each([
    ['インライン', '![図](images/a.png)\n', ['images/a.png']],
    ['複数', '[a](x.png)\n[b](y.pdf)\n', ['x.png', 'y.pdf']],
    ['題名つき', '[a](path.png "題名")\n', ['path.png']],
    ["題名つき(')", "[a](path.png 'title')\n", ['path.png']],
    ['山括弧', '[a](<my file.png>)\n', ['my file.png']],
    ['括弧 1 段', '[a](path_(1).png)\n', ['path_(1).png']],
    ['空白まわり', '[a](  x.png  )\n', ['x.png']],
    ['asset 参照', '![図](asset:ast-1)\n', ['asset:ast-1']],
    ['参照形式の定義', '![図][a]\n\n[a]: images/a.png\n', ['images/a.png']],
    ['参照形式 + 題名', '[a]: images/a.png "題名"\n', ['images/a.png']],
    ['参照形式 + 山括弧', '[a]: <my file.png>\n', ['my file.png']],
    ['HTML img', '<img src="images/a.png" alt="x">\n', ['images/a.png']],
    ['HTML a', "<a href='docs/b.pdf'>x</a>\n", ['docs/b.pdf']],
    ['HTML 引用符なし', '<a href=docs/b.pdf>x</a>\n', ['docs/b.pdf']],
  ])('%s', (_label, src, expected) => {
    expect(dests(src)).toEqual(expected);
  });

  it('種別を返す(consumer が書換対象を選べる)', () => {
    expect(kinds('[a](x.png)\n\n[b]: y.png\n\n<img src="z.png">\n')).toEqual([
      'inline',
      'reference',
      'html',
    ]);
  });
});

describe('🔴 拾わない ── コードとエスケープ', () => {
  it.each([
    ['fence の中', '```md\n![例](images/example.png)\n```\n'],
    ['~~~ fence の中', '~~~\n[a](x.png)\n~~~\n'],
    ['行内コード', 'a `](foo.png)` b\n'],
    ['エスケープした `]`', 'a \\](notalink.png) b\n'],
  ])('%s', (_label, src) => {
    expect(dests(src)).toEqual([]);
  });

  it('🔴 閉じ fence は**開き以上の長さ**が要る', () => {
    // 4 個で開いて 3 個で閉じない = markdown を説明する文書が壊れない
    expect(dests('````\n```\n[a](x.png)\n```\n````\n[b](y.png)\n')).toEqual(['y.png']);
  });

  it('🔴 閉じ fence は 3 スペースまで字下げできる(以降を全部飲まない)', () => {
    expect(dests('```\ncode\n  ```\n\n[a](x.png)\n')).toEqual(['x.png']);
  });

  it('🔴 行内コードは空行を越えない(間の本文を飲まない)', () => {
    expect(dests('`x\n\n[a](y.png)\n\n`z\n')).toEqual(['y.png']);
  });

  it('閉じない fence は末尾まで飲み、その事実を返す', () => {
    const r = scanLinks('```\n[a](x.png)\n');
    expect(r.sites).toEqual([]);
    expect(r.openFence).toBe('```');
  });

  it('閉じた fence では openFence は null', () => {
    expect(scanLinks('```\ncode\n```\n').openFence).toBe(null);
  });

  it('参照形式の定義は**行頭**だけ(文中の `[a]:` は拾わない)', () => {
    expect(dests('見よ [a]: images/a.png と書く\n')).toEqual([]);
  });
});

describe('宛先だけを差し替える', () => {
  const upper = (text: string): string =>
    rewriteLinkDests(text, scanLinks(text).sites, (s) => s.dest.toUpperCase());

  it('インラインの宛先だけが変わる(題名・記法は残る)', () => {
    expect(upper('[a](x.png "題名")\n')).toBe('[a](X.PNG "題名")\n');
  });

  it('🔴 山括弧は**残す**(空白を含む path で壊れないため)', () => {
    expect(upper('[a](<my file.png>)\n')).toBe('[a](<MY FILE.PNG>)\n');
  });

  it('参照形式・HTML も同じ規則で替わる', () => {
    expect(upper('[a]: x.png\n')).toBe('[a]: X.PNG\n');
    expect(upper('<img src="x.png" alt="図">\n')).toBe('<img src="X.PNG" alt="図">\n');
  });

  it('`undefined` を返した site はそのまま残る', () => {
    const text = '[a](keep.png)\n[b](drop.png)\n';
    const out = rewriteLinkDests(text, scanLinks(text).sites, (s) =>
      s.dest === 'drop.png' ? 'new.png' : undefined,
    );
    expect(out).toBe('[a](keep.png)\n[b](new.png)\n');
  });

  it('何も替えなければ原文と byte 同一', () => {
    const text = '```\n[a](x.png)\n```\n[b](y.png)\n<img src="z.png">\n';
    expect(rewriteLinkDests(text, scanLinks(text).sites, () => undefined)).toBe(text);
  });
});
