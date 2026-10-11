/**
 * 🔴 **板のテンプレート(W4)と「位置と大きさ…」(W2)**(#529。Gemini 裁定 = 採択)。
 *
 * ## 守る主張
 *
 * 1. 🔴 テンプレートが足した字を**実物の描画器**に渡すと、決めた数の枠(と線)として読まれる
 *    ── 数えるのは `PLACE_TEMPLATES` の自己申告ではなく、描画が `pkc-place` と描いた塊の数
 * 2. 🔴 新しい記法を作らない ── 足した字は、板の読み手が受ける綴り(`isPlaceOpen` / `.pkc-line`)だけ
 * 3. 🔴 流れ図の名前は、本文で使われている名前と重ならない(線が別の枠を指さない)
 * 4. 🔴 位置と大きさ: 渡した札だけが変わり、他の行・他の札は 1 byte も変わらない。
 *    全角数字を受ける。負・小数・非数・上限超えは理由を言って断る。空欄は「変えない」
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/features/markdown/markdown-render';
import {
  addPlaceTemplate,
  isPlaceOpen,
  placeRectOf,
  setPlaceRect,
} from '../../src/features/markdown/place-notation';
import {
  parsePlaceRect,
  PLACE_RECT_MAX,
  type PlaceRectInput,
} from '../../src/features/markdown/place-rect';
import { PLACE_TEMPLATES } from '../../src/features/markdown/place-template';

/** 描画が板として描いた塊の開きタグ(座標つき)。 */
function renderedFrames(body: string): string[] {
  const html = renderMarkdown(body, { sourceLineAnchors: true } as never);
  return [...html.matchAll(/<div[^>]*class="[^"]*pkc-format-block[^"]*pkc-place[^"]*"[^>]*>/g)].map(
    (m) => m[0],
  );
}

function renderedLines(body: string): string[] {
  const html = renderMarkdown(body, { sourceLineAnchors: true } as never);
  return [...html.matchAll(/<div[^>]*class="[^"]*pkc-line[^"]*"[^>]*>/g)].map((m) => m[0]);
}

describe('板のテンプレート(addPlaceTemplate)', () => {
  // 描画に頼らない形の数え方 ── 開き行が板として受理される行の数
  const openLines = (body: string): number =>
    body.split('\n').filter((l) => isPlaceOpen(l)).length;

  it('🔴 付箋 4 枚 ── 描画が 4 枚の板として読み、2 × 2 に並ぶ', () => {
    const next = addPlaceTemplate('', 100, 50, 'sticky4')!;
    const frames = renderedFrames(next);
    expect(frames).toHaveLength(4);
    expect(openLines(next)).toBe(4);
    const xs = frames.map((f) => /data-pkc-x="(\d+)"/.exec(f)![1]);
    const ys = frames.map((f) => /data-pkc-y="(\d+)"/.exec(f)![1]);
    // 2 × 2 = 横に 2 つの位置・縦に 2 つの位置(4 枚が 1 点に重ならない)
    expect(new Set(xs).size, '横の位置が 2 通りでない').toBe(2);
    expect(new Set(ys).size, '縦の位置が 2 通りでない').toBe(2);
    expect(Math.min(...xs.map(Number))).toBe(100);
    expect(Math.min(...ys.map(Number))).toBe(50);
    // 空の付箋(題名の札も中身も無い)
    expect(next).not.toContain('entry=');
  });

  it('🔴 3 段の流れ図 ── 3 枚の枠と、左から右へ 2 本の線', () => {
    const next = addPlaceTemplate('', 0, 0, 'flow3')!;
    const frames = renderedFrames(next);
    expect(frames).toHaveLength(3);
    const xs = frames.map((f) => Number(/data-pkc-x="(\d+)"/.exec(f)![1]));
    expect(xs, '左から右へ並んでいない').toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(3);
    const lines = renderedLines(next);
    expect(lines, '線が 2 本でない').toHaveLength(2);
    // 線は 1→2 と 2→3 を指し、指す名前は枠の id として実在する
    const html = renderMarkdown(next, { sourceLineAnchors: true } as never);
    const pairs = lines.map((l) => [
      /data-pkc-from="([^":]+)/.exec(l)![1],
      /data-pkc-to="([^":]+)/.exec(l)![1],
    ]);
    const ids = frames.map((f) => /id="([^"]+)"/.exec(f)![1]);
    expect(pairs).toEqual([
      [ids[0], ids[1]],
      [ids[1], ids[2]],
    ]);
    expect(html).toContain(`id="${ids[0]}"`);
  });

  it('🔴 2 × 2 の表 ── 4 象限 + 縦横の見出し 4 枚 = 8 枚', () => {
    const next = addPlaceTemplate('', 0, 0, 'matrix2')!;
    expect(renderedFrames(next)).toHaveLength(8);
    for (const h of ['見出し A', '見出し B', '見出し 1', '見出し 2']) expect(next).toContain(h);
    // 見出しの帯の分だけ象限は右下へずれる(象限が見出しの上に乗らない)
    const frames = renderedFrames(next).map((f) => ({
      x: Number(/data-pkc-x="(\d+)"/.exec(f)![1]),
      y: Number(/data-pkc-y="(\d+)"/.exec(f)![1]),
    }));
    const keys = new Set(frames.map((f) => `${f.x},${f.y}`));
    expect(keys.size, '同じ位置に重なった枠がある').toBe(8);
  });

  it('🔴 申告(PLACE_TEMPLATES.frames)は描画が読んだ数と一致する(自己申告だけの数を作らない)', () => {
    expect(PLACE_TEMPLATES).toHaveLength(3);
    for (const t of PLACE_TEMPLATES) {
      const next = addPlaceTemplate('', 0, 0, t.id)!;
      expect(renderedFrames(next), t.id).toHaveLength(t.frames);
    }
  });

  it('🔴 元の本文は 1 byte も動かず、後ろに足される(空行 1 本で区切る)', () => {
    const body = '# 題\n\n本文\n';
    for (const t of PLACE_TEMPLATES) {
      const next = addPlaceTemplate(body, 10, 20, t.id)!;
      expect(next.startsWith(`${body}\n:::format{`), t.id).toBe(true);
      expect(next.endsWith('\n')).toBe(true);
    }
    expect(addPlaceTemplate('本文', 0, 0, 'sticky4')!.startsWith('本文\n\n:::format{')).toBe(true);
  });

  it('🔴 流れ図の名前は、本文で使われている名前を避ける(線が別の枠を指さない)', () => {
    const body = ':::format{#板1 .pkc-place x=0 y=0 w=100 h=50}\n:::\n\n:::format{#板2 .pkc-place x=0 y=80}\n:::\n';
    const next = addPlaceTemplate(body, 300, 0, 'flow3')!;
    const added = next.slice(body.length);
    expect(added).not.toMatch(/#板1[ }]/);
    expect(added).not.toMatch(/#板2[ }]/);
    expect(added).toMatch(/#板3 /);
    // 同じ名前の id が 2 つの枠に付いていない
    const ids = renderedFrames(next).map((f) => /id="([^"]+)"/.exec(f)?.[1]);
    const named = ids.filter((i): i is string => i !== undefined);
    expect(new Set(named).size, '同じ id が重なった').toBe(named.length);
  });

  it('🔴 同じテンプレートを 2 回置いても、名前は重ならない', () => {
    const once = addPlaceTemplate('', 0, 0, 'flow3')!;
    const twice = addPlaceTemplate(once, 0, 300, 'flow3')!;
    const ids = renderedFrames(twice).map((f) => /id="([^"]+)"/.exec(f)![1]);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('閉じていない囲いの中へは足さない / 負・小数の座標・知らないテンプレートは null', () => {
    expect(addPlaceTemplate('本文\n```js\nconst a = 1;\n', 0, 0, 'sticky4')).toBeNull();
    expect(addPlaceTemplate(':::note\nまだ\n', 0, 0, 'sticky4')).toBeNull();
    expect(addPlaceTemplate('本文\n```js\nx\n```\n', 0, 0, 'sticky4')).not.toBeNull();
    expect(addPlaceTemplate('', -1, 0, 'sticky4')).toBeNull();
    expect(addPlaceTemplate('', 0, 1.5, 'sticky4')).toBeNull();
    expect(addPlaceTemplate('', 0, 0, 'nope' as never)).toBeNull();
  });
});

describe('位置と大きさの検め(parsePlaceRect)', () => {
  const input = (o: Partial<PlaceRectInput>): PlaceRectInput => ({ x: '', y: '', w: '', h: '', ...o });

  it('🔴 半角の整数は数になる', () => {
    expect(parsePlaceRect(input({ x: '120', y: '40', w: '320', h: '200' }))).toEqual({
      ok: true,
      rect: { x: 120, y: 40, w: 320, h: 200 },
    });
  });

  it('🔴 全角数字(日本語入力のまま)も受ける', () => {
    expect(parsePlaceRect(input({ x: '１２０', y: ' ４０ ', w: '３２０', h: '２００' }))).toEqual({
      ok: true,
      rect: { x: 120, y: 40, w: 320, h: 200 },
    });
  });

  it('🔴 空欄は「変えない」(その札は値に入らない)', () => {
    expect(parsePlaceRect(input({ x: '5' }))).toEqual({ ok: true, rect: { x: 5 } });
    expect(parsePlaceRect(input({}))).toEqual({ ok: true, rect: {} });
  });

  it.each([
    ['負', { x: '-5' }, 'x', '0 以上'],
    ['全角の負', { y: '－５' }, 'y', '0 以上'],
    ['小数', { w: '12.5' }, 'w', '整数'],
    ['数でない字', { h: 'あ' }, 'h', '整数'],
    ['単位つき', { x: '12px' }, 'x', '整数'],
    ['上限超え', { x: String(PLACE_RECT_MAX + 1) }, 'x', String(PLACE_RECT_MAX)],
    ['幅 0', { w: '0' }, 'w', '1 以上'],
    ['高さ 0', { h: '0' }, 'h', '1 以上'],
  ] as const)('🔴 断る: %s ── 理由を言い、その欄を指す', (_n, o, key, word) => {
    const r = parsePlaceRect(input(o));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.key).toBe(key);
    expect(r.error).toContain(word);
  });

  it('上限ちょうどは通り、x / y の 0 も通る(境界の対照群)', () => {
    expect(parsePlaceRect(input({ x: String(PLACE_RECT_MAX), y: '0' }))).toEqual({
      ok: true,
      rect: { x: PLACE_RECT_MAX, y: 0 },
    });
  });
});

describe('位置と大きさを書く(setPlaceRect)', () => {
  const OPEN = ':::format{.pkc-place x=10 y=20 w=240 h=120 z=3}';
  const BODY = `前\n\n${OPEN}\nメモ\n:::\n\n:::format{#b .pkc-place x=1 y=2}\n:::\n`;
  const at = (line: number, openLine: string) => ({ line, openLine });

  it('🔴 渡した 4 つの札だけが変わり、z= も他の塊も 1 byte も変わらない', () => {
    const next = setPlaceRect(BODY, at(2, OPEN), { x: 100, y: 200, w: 300, h: 150 })!;
    const lines = next.split('\n');
    expect(lines[2]).toBe(':::format{.pkc-place x=100 y=200 w=300 h=150 z=3}');
    // 他の行は一致
    expect(lines.filter((_, i) => i !== 2)).toEqual(BODY.split('\n').filter((_, i) => i !== 2));
  });

  it('🔴 渡した札だけ ── 位置だけなら w= h= に触らない', () => {
    const next = setPlaceRect(BODY, at(2, OPEN), { x: 7, y: 8 })!;
    expect(next.split('\n')[2]).toBe(':::format{.pkc-place x=7 y=8 w=240 h=120 z=3}');
  });

  it('w= h= の無い枠には足す / 札が 0 個なら body をそのまま返す(null ではない)', () => {
    const b = ':::format{#b .pkc-place x=1 y=2}\n:::\n';
    const open = b.split('\n')[0]!;
    expect(setPlaceRect(b, at(0, open), { w: 50, h: 60 })!.split('\n')[0]).toBe(
      ':::format{#b .pkc-place x=1 y=2 w=50 h=60}',
    );
    expect(setPlaceRect(b, at(0, open), {})).toBe(b);
  });

  it('🔴 範囲外・小数の値が 1 つでもあれば全体を断る(一部だけ書かない)', () => {
    expect(setPlaceRect(BODY, at(2, OPEN), { x: 5, w: 0 })).toBeNull();
    expect(setPlaceRect(BODY, at(2, OPEN), { x: -1 })).toBeNull();
    expect(setPlaceRect(BODY, at(2, OPEN), { y: 1.5 })).toBeNull();
    expect(setPlaceRect(BODY, at(2, OPEN), { h: PLACE_RECT_MAX + 1 })).toBeNull();
  });

  it('🔴 同じ門 ── 開き行が違う / 板でない行 は書かない', () => {
    expect(setPlaceRect(BODY, at(2, ':::format{.pkc-place x=99 y=99}'), { x: 1 })).toBeNull();
    expect(setPlaceRect(BODY, at(0, '前'), { x: 1 })).toBeNull();
  });

  it('いまの値を窓へ(placeRectOf)── 書かれていない札は空', () => {
    expect(placeRectOf(OPEN)).toEqual({ x: '10', y: '20', w: '240', h: '120' });
    expect(placeRectOf(':::format{#b .pkc-place x=1 y=2}')).toEqual({ x: '1', y: '2', w: '', h: '' });
    expect(placeRectOf('ふつうの行')).toBeNull();
  });
});
