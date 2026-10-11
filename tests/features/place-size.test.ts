/** @vitest-environment happy-dom */
/**
 * 🔴 **付箋の文字の大きさ**(#530 段⑤a。Gemini 裁定 2026-10-11 依頼 19 Q1)── 記法・書込・PowerPoint の往復。
 *
 * 守る主張:
 * 1. 記法: `size=small` / `large` / `xlarge`。札が無い・空・`standard` = 標準。読めない字は `bad`(`placeSizeOf` は標準へ倒す)
 * 2. 書込: 「標準」は札を**消す**(`size=standard` と書かない)。付箋の行にだけ書け、線の行は断る。他の札・他の行は 1 字も動かない
 * 3. 「色を外す」の出る条件(`any`)は大きさを数えない(外しても消えない札で口を出さない)
 * 4. PowerPoint: 段 → `sz`(14 / 18 / 27 / 40pt)が出て、読み戻すと同じ `size=`。標準の XML は 1 byte も変わらない
 * 5. 取り込み: 外から来た `sz` は**いちばん近い段**へ丸め、丸めた枚数を数える(段の値とちょうど同じなら数えない)
 */
import { describe, expect, it } from 'vitest';
import { htmlToDocxBlocks } from '@adapter/platform/export/html-blocks';
import { buildPptx, type ExportBlock } from '@features/export/pptx';
import { readPptxSlide } from '@features/import/pptx-board';
import { applyBodyRewrite } from '@features/markdown/body-rewrite';
import { renderMarkdown } from '@features/markdown/markdown-render';
import {
  BOARD_STYLE_KEYS,
  isPlaceStyle,
  LINE_STYLE_KEYS,
  nearestPlaceSize,
  parseSizeSpell,
  placeSizeOf,
  PLACE_SIZES,
  PLACE_SIZE_PPTX_SZ,
  type PlaceSize,
} from '@features/markdown/place-color';
import { placeStyleAt, setPlaceStyle } from '@features/markdown/place-notation';
import { TEXT_SCALES } from '@features/text-scale';

describe('記法(size=)', () => {
  it('🔴 small / large / xlarge は読める。札が無い・空・standard は標準。読めない字は bad', () => {
    expect(PLACE_SIZES.length, '一覧が空だと下の検査が何も見ない').toBe(4);
    expect(parseSizeSpell('small')).toEqual({ kind: 'ok', size: 'small' });
    expect(parseSizeSpell(' large ')).toEqual({ kind: 'ok', size: 'large' });
    expect(parseSizeSpell('xlarge')).toEqual({ kind: 'ok', size: 'xlarge' });
    expect(parseSizeSpell('standard')).toEqual({ kind: 'ok', size: 'standard' });
    expect(parseSizeSpell(null)).toEqual({ kind: 'none' });
    expect(parseSizeSpell('')).toEqual({ kind: 'none' });
    expect(parseSizeSpell('huge')).toEqual({ kind: 'bad', raw: 'huge' });
    expect(parseSizeSpell('LARGE')).toEqual({ kind: 'bad', raw: 'LARGE' }); // 大文字は別の字
    expect(parseSizeSpell('20')).toEqual({ kind: 'bad', raw: '20' }); // 数(px)は受けない
    expect(placeSizeOf('huge'), '読めない字は標準(描く側の規則)').toBe('standard');
    expect(placeSizeOf(true), '値なしの札(size)も標準').toBe('standard');
    expect(placeSizeOf('xlarge')).toBe('xlarge');
  });

  it('🔴 段の名前と並びは設定の「文字の大きさ」と同じ(正本は text-scale.ts の 1 枚)', () => {
    expect([...PLACE_SIZES]).toEqual(TEXT_SCALES.map((t) => t.id));
  });

  it('🔴 持てる札: 付箋だけが size を持つ(線は持たない)', () => {
    expect(BOARD_STYLE_KEYS).toContain('size');
    expect(LINE_STYLE_KEYS).not.toContain('size');
    expect(isPlaceStyle({ size: 'large' })).toBe(true);
    expect(isPlaceStyle({ size: null })).toBe(true);
    expect(isPlaceStyle({ size: 'huge' })).toBe(false);
  });
});

describe('書込(setPlaceStyle)と読み(placeStyleAt)', () => {
  const OPEN = ':::format{#a .pkc-place x=0 y=0 w=100 h=60}';
  const BODY = [OPEN, '左', ':::', '', ':::format{.pkc-line from=a to=a}', ':::', ''].join('\n');
  const write = (body: string, size: PlaceSize | null): string | null =>
    setPlaceStyle(body, { line: 0, openLine: body.split('\n')[0]! }, { size });

  it('🔴 large → size=large / 札は 1 つだけ / standard・null → 札が消える(size=standard と書かない)', () => {
    const large = write(BODY, 'large')!;
    expect(large.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 size=large}');
    const xl = write(large, 'xlarge')!;
    expect(xl.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 size=xlarge}');
    for (const off of ['standard', null] as const) {
      const cleared = write(xl, off)!;
      expect(cleared, off ?? 'null').toBe(BODY);
      expect(cleared).not.toContain('size');
    }
  });

  it('標準が元から標準の付箋に「標準」を書いても本文は動かない', () => {
    expect(write(BODY, 'standard')).toBe(BODY);
  });

  it('🔴 色と並ぶ: 色は残り、他の行は 1 字も動かない', () => {
    const body = BODY.replace(OPEN, ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a}');
    const next = write(body, 'small')!;
    expect(next.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a size=small}');
    expect(next.split('\n').slice(1)).toEqual(body.split('\n').slice(1));
  });

  it('🔴 線の行には書かない(持てない札)。対照群: 同じ線へ持てる札(width)は書ける', () => {
    const at = { line: 4, openLine: BODY.split('\n')[4]! };
    expect(setPlaceStyle(BODY, at, { size: 'large' })).toBeNull();
    expect(setPlaceStyle(BODY, at, { width: 4 })).not.toBeNull();
  });

  it('🔴 applyBodyRewrite(store-effects が書く当の関数)を通っても同じ', () => {
    const next = applyBodyRewrite(BODY, { kind: 'place-style', line: 0, openLine: OPEN, style: { size: 'large' } });
    expect(next?.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 size=large}');
  });

  it('🔴 読み: いまの大きさと「書かれているか」。any(色を外す口の条件)は大きさを数えない', () => {
    expect(placeStyleAt(OPEN)).toMatchObject({ size: 'standard', written: { size: false }, any: false });
    const large = `${OPEN.slice(0, -1)} size=large}`;
    expect(placeStyleAt(large)).toMatchObject({ size: 'large', written: { size: true }, any: false });
    // 読めない字: 標準で、書かれてはいる
    expect(placeStyleAt(`${OPEN.slice(0, -1)} size=huge}`)).toMatchObject({ size: 'standard', written: { size: true } });
    // 色が一緒なら any は真(色の札のために)
    expect(placeStyleAt(`${OPEN.slice(0, -1)} size=large fill=#fff}`)).toMatchObject({ any: true });
    // 線の行は size を持たない
    expect(placeStyleAt(':::format{.pkc-line from=a to=b size=large}')).toMatchObject({
      size: 'standard',
      written: { size: false },
    });
  });
});

describe('PowerPoint ── 書き出し', () => {
  const BOARD = (extra = ''): string =>
    [`:::format{#a .pkc-place x=0 y=0 w=200 h=100${extra}}`, '左', ':::', ''].join('\n');
  const slideOf = (blocks: readonly ExportBlock[]): string => {
    const r = buildPptx(blocks, { title: 'T' });
    const hit = r.parts.find((x) => x.name === 'ppt/slides/slide1.xml');
    expect(hit, 'slide1.xml が無い').toBeTruthy();
    return hit!.text;
  };
  const fromMarkdown = (md: string): string => {
    const doc = new DOMParser().parseFromString(`<body>${renderMarkdown(md)}</body>`, 'text/html');
    return slideOf(htmlToDocxBlocks(doc).blocks);
  };
  const szOf = (xml: string): string[] => [...xml.matchAll(/ sz="(\d+)"/g)].map((m) => m[1]!);

  it('🔴 段の表: 標準は今までの 1800。小 < 標準 < 大 < 特大', () => {
    expect(PLACE_SIZE_PPTX_SZ).toEqual({ small: 1400, standard: 1800, large: 2700, xlarge: 4000 });
  });

  it.each([
    [' size=small', '1400'],
    [' size=large', '2700'],
    [' size=xlarge', '4000'],
  ])('🔴 本文 → 画面の HTML → 塊 → .pptx: %s は sz=%s', (extra, sz) => {
    expect(szOf(fromMarkdown(BOARD(extra)))).toEqual([sz]);
  });

  it('🔴 対照群: 標準・読めない字・standard の付箋は今までと 1 byte も変わらない(sz=1800)', () => {
    const plain = fromMarkdown(BOARD());
    expect(szOf(plain)).toEqual(['1800']);
    expect(fromMarkdown(BOARD(' size=huge'))).toBe(plain);
    expect(fromMarkdown(BOARD(' size=standard'))).toBe(plain);
  });

  it('🔴 付箋の中の全部の行に同じ大きさが掛かる(見出し・箇条書きも)', () => {
    const md = ':::format{#a .pkc-place x=0 y=0 w=200 h=100 size=large}\n## 見出し\n\n- あ\n- い\n:::\n';
    const sz = szOf(fromMarkdown(md));
    expect(sz.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sz)).toEqual(new Set(['2700']));
  });
});

describe('PowerPoint ── 取り込み(近い段へ丸める)', () => {
  const place = (size?: PlaceSize): ExportBlock => ({
    kind: 'place', x: 0, y: 0, w: 200, h: 100, shape: 'rect', name: null, span: 1,
    ...(size !== undefined && size !== 'standard' ? { size } : {}),
  });
  const p = (text: string): ExportBlock => ({ kind: 'p', runs: [{ text }] });
  const slideOf = (blocks: readonly ExportBlock[]): string =>
    buildPptx(blocks, { title: 'T' }).parts.find((x) => x.name === 'ppt/slides/slide1.xml')!.text;
  const openOf = (body: string): string => /^:::format\{[^}]*\.pkc-place[^}]*\}$/m.exec(body)![0];
  /** 書き出した XML の `sz` を、外から来た file のように書き換える。 */
  const withSz = (xml: string, from: string, to: string): string => {
    const out = xml.split(` sz="${from}"`).join(` sz="${to}"`);
    expect(out, `sz=${from} が書き換わっていない`).not.toBe(xml);
    return out;
  };

  it('🔴 往復: 小 / 大 / 特大 は size= に戻り、丸めた数は 0(段の値とちょうど同じ)。標準は札を足さない', () => {
    for (const size of ['small', 'large', 'xlarge'] as const) {
      const got = readPptxSlide(slideOf([place(size), p('A')]));
      expect(openOf(got.body), size).toContain(` size=${size}`);
      expect(got.rounded, `${size}: 自分が書いた file は丸めない`).toBe(0);
    }
    const std = readPptxSlide(slideOf([place(), p('A')]));
    expect(openOf(std.body)).not.toContain('size=');
    expect(std.rounded).toBe(0);
  });

  it.each([
    ['2000', 'standard'], // 20pt → 標準(18 まで 2 / 27 まで 7)
    ['2400', 'large'], // 24pt → 大(27 まで 3 / 18 まで 6)
    ['1200', 'small'], // 12pt → 小
    ['6000', 'xlarge'], // 60pt → 特大(上へはみ出しても最も近い段)
    ['800', 'small'], // 8pt → 小(下へはみ出しても最も近い段)
    ['2250', 'large'], // 22.5pt = 18 と 27 の真ん中 → 大きい側
  ] as const)('🔴 sz を %s に書き換えた file は %s へ丸め、丸めた付箋として数える', (to, step) => {
    const got = readPptxSlide(withSz(slideOf([place(), p('A')]), '1800', to));
    if (step === 'standard') expect(openOf(got.body)).not.toContain('size=');
    else expect(openOf(got.body)).toContain(` size=${step}`);
    expect(got.rounded).toBe(1);
  });

  it('🔴 nearestPlaceSize: 4 段の境目(差の絶対値。真ん中は大きい側)', () => {
    expect(nearestPlaceSize(1599)).toBe('small');
    expect(nearestPlaceSize(1600)).toBe('standard');
    expect(nearestPlaceSize(2249)).toBe('standard');
    expect(nearestPlaceSize(2250)).toBe('large');
    expect(nearestPlaceSize(3349)).toBe('large');
    expect(nearestPlaceSize(3350)).toBe('xlarge');
  });

  it('🔴 1 枚の中で字の大きさがまちまちなら、字数がいちばん多い大きさを採る', () => {
    const xml = slideOf([place(), p('あいうえおかきくけこ')]); // 10 字 sz=1800
    const mixed = xml.replace(
      /<a:r>(<a:rPr[^>]*? sz="1800"[\s\S]*?<\/a:rPr>)<a:t>あいうえおかきくけこ<\/a:t><\/a:r>/,
      (_m, rpr: string) =>
        // ⚠ 少ない側(2 字 / 18pt)を**先に**置く ── 「最初の run の大きさ」を採る実装では 18pt になって落ちる
        `<a:r>${rpr}<a:t>あい</a:t></a:r><a:r>${rpr.replace('sz="1800"', 'sz="2700"')}<a:t>あいうえおかきくけこ</a:t></a:r>`,
    );
    expect(mixed).not.toBe(xml);
    const got = readPptxSlide(mixed);
    expect(openOf(got.body)).toContain(' size=large'); // 10 字(27pt)> 2 字(18pt)
    expect(got.rounded).toBe(0);
  });

  it('🔴 normAutofit の fontScale を掛けてから丸める(27pt の 66.667% は 18pt 相当 = 標準)', () => {
    const base = slideOf([place('large'), p('A')]);
    expect(base).toContain('<a:normAutofit/>');
    const scaled = base.replace('<a:normAutofit/>', '<a:normAutofit fontScale="66667"/>');
    const got = readPptxSlide(scaled);
    expect(openOf(got.body)).not.toContain('size=');
    expect(got.rounded, '2700 × 0.66667 = 1800(整数に丸めるとちょうど標準)').toBe(0);
    // 62.5% なら 1687.5 → 近いのは標準だが、ちょうどではないので「丸めた」と数える
    const rough = readPptxSlide(base.replace('<a:normAutofit/>', '<a:normAutofit fontScale="62500"/>'));
    expect(openOf(rough.body)).not.toContain('size=');
    expect(rough.rounded).toBe(1);
    // 対照群: fontScale が無ければ大のまま
    expect(openOf(readPptxSlide(base).body)).toContain(' size=large');
  });

  it('sz がどこにも無い付箋は標準で、丸めた数にも数えない', () => {
    const xml = slideOf([place(), p('A')]).replace(/ sz="\d+"/g, '');
    const got = readPptxSlide(xml);
    expect(openOf(got.body)).not.toContain('size=');
    expect(got.rounded).toBe(0);
  });
});
