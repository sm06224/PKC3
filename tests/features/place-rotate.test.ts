/**
 * 🔴 **付箋の回転**(#530 段⑤d。Gemini 裁定 2026-10-11 依頼 19 Q2)── 記法と計算(features 層)。
 *
 * 守る主張:
 * 1. 記法 `rotate=度`: 0〜359 の整数だけ読む。負・小数・単位つき・360 以上は読めない(= 回さない。本文は消さない)
 * 2. 書き込み: 0 は札を消す(`rotate=0` と書き足さない)/ 他の札・他の行は 1 字も動かない / 札の無い付箋は 1 バイトも変わらない
 * 3. 計算: 回した付箋の接続点・辺の判定・離した先の当たりが、**中心の周りに回した四角**で決まる(0 / 15 / 45 / 90 / 180 度)
 * 4. 角の伸縮: 付箋の向きで伸び、反対側の角(左上)が画面で動かない
 */
import { describe, expect, it } from 'vitest';
import { anchorOf, anchorPoint, placeLineOf } from '../../src/features/markdown/place-line';
import { nearestEdge, topPlaceAt } from '../../src/features/markdown/place-handles';
import { setPlaceStyle, placeStyleAt } from '../../src/features/markdown/place-notation';
import {
  parsePlaceRotate,
  placeRotateOf,
  resizeRotated,
  rotatedBounds,
  rotatedCorners,
  stepPlaceRotate,
  unrotatePoint,
} from '../../src/features/markdown/place-rotate';

const near = (a: number, b: number, eps = 1e-9): void => {
  expect(Math.abs(a - b)).toBeLessThan(eps);
};

describe('rotate= を読む', () => {
  it.each([
    ['0', 0],
    ['15', 15],
    ['345', 345],
    ['359', 359],
    [' 90 ', 90],
    ['007', 7],
  ])('読める: %s → %i', (raw, deg) => {
    expect(parsePlaceRotate(raw)).toBe(deg);
    expect(placeRotateOf(raw)).toBe(deg);
  });

  it.each(['-15', '7.5', '15deg', '360', '999', '1000', '', ' ', 'abc', '+15', '1e1'])(
    '読めない: "%s" は回さない(null / 0)',
    (raw) => {
      expect(parsePlaceRotate(raw)).toBeNull();
      expect(placeRotateOf(raw)).toBe(0);
    },
  );

  it('文字列でない物(属性が無い = null / undefined)も回さない', () => {
    expect(parsePlaceRotate(null)).toBeNull();
    expect(parsePlaceRotate(undefined)).toBeNull();
    expect(parsePlaceRotate(15)).toBeNull();
  });

  it('15° ずつ右・左へ。0 をまたいでも 0〜359 に畳む。15 の倍数でない角度からも 15° 動く', () => {
    expect(stepPlaceRotate(0, 1)).toBe(15);
    expect(stepPlaceRotate(0, -1)).toBe(345);
    expect(stepPlaceRotate(345, 1)).toBe(0);
    expect(stepPlaceRotate(15, -1)).toBe(0);
    expect(stepPlaceRotate(20, 1)).toBe(35);
    expect(stepPlaceRotate(20, -1)).toBe(5);
    // 24 回右へ回すと一周して元に戻る
    let d = 0;
    for (let i = 0; i < 24; i += 1) d = stepPlaceRotate(d, 1);
    expect(d).toBe(0);
  });
});

describe('rotate= を書く(setPlaceStyle)', () => {
  const OPEN = ':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a}';
  const body = [OPEN, '左', ':::', ''].join('\n');
  const target = { line: 0, openLine: OPEN };

  it('🔴 札の無い付箋に 45 を書く → 末尾に rotate=45。他の札・他の行は 1 字も動かない', () => {
    const next = setPlaceStyle(body, target, { rotate: 45 })!;
    expect(next.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a rotate=45}');
    expect(next.split('\n').slice(1)).toEqual(body.split('\n').slice(1));
  });

  it('🔴 0 / null は札を消す(rotate=0 と書き足さない)。札が元から無ければ 1 バイトも変わらない', () => {
    const rotated = setPlaceStyle(body, target, { rotate: 45 })!;
    const rotatedOpen = rotated.split('\n')[0]!;
    const cleared = setPlaceStyle(rotated, { line: 0, openLine: rotatedOpen }, { rotate: 0 })!;
    expect(cleared).toBe(body);
    expect(setPlaceStyle(rotated, { line: 0, openLine: rotatedOpen }, { rotate: null })).toBe(body);
    // 元から無い札を消す依頼 ── body をそのまま返す(null ではない)
    expect(setPlaceStyle(body, target, { rotate: null })).toBe(body);
    expect(setPlaceStyle(body, target, { rotate: 0 })).toBe(body);
  });

  it('🔴 書き替え: rotate=45 → 60 は札が 1 つのまま(重ならない)', () => {
    const a = setPlaceStyle(body, target, { rotate: 45 })!;
    const b = setPlaceStyle(a, { line: 0, openLine: a.split('\n')[0]! }, { rotate: 60 })!;
    expect(b.split('\n')[0]).toBe(':::format{#a .pkc-place x=0 y=0 w=100 h=60 fill=#ffe08a rotate=60}');
  });

  it.each([-15, 15.5, 360, 400, Number.NaN, '45' as unknown as number])(
    '書けない値は断る(null): %s',
    (v) => {
      expect(setPlaceStyle(body, target, { rotate: v })).toBeNull();
    },
  );

  it('🔴 線には書けない(線は回さない。持てない札は断る)', () => {
    const LINE = ':::format{.pkc-line from=a:right to=b:left}';
    const lb = [LINE, ':::', ''].join('\n');
    expect(setPlaceStyle(lb, { line: 0, openLine: LINE }, { rotate: 15 })).toBeNull();
  });

  it('placeStyleAt: rotate は読めた値、written は書かれているか(読めない値も真)、any には数えない', () => {
    expect(placeStyleAt(':::format{.pkc-place x=0 y=0 rotate=45}')).toMatchObject({
      rotate: 45,
      any: false,
      written: { rotate: true },
    });
    expect(placeStyleAt(':::format{.pkc-place x=0 y=0 rotate=-5}')).toMatchObject({
      rotate: 0,
      any: false,
      written: { rotate: true },
    });
    expect(placeStyleAt(':::format{.pkc-place x=0 y=0}')).toMatchObject({
      rotate: 0,
      written: { rotate: false },
    });
  });
});

describe('回した四角の計算', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 }; // 中心 (200, 150)

  it('90°: 右辺の真ん中は、画面の下側(中心の真下 w/2)へ来る', () => {
    const p = anchorPoint({ ...r, rot: 90 }, anchorOf('right'));
    near(p.x, 200);
    near(p.y, 150 + 100); // 中心 + w/2
  });

  it('180°: 右辺の真ん中は左端へ、上辺の真ん中は下辺の位置へ', () => {
    const right = anchorPoint({ ...r, rot: 180 }, anchorOf('right'));
    near(right.x, 100);
    near(right.y, 150);
    const top = anchorPoint({ ...r, rot: 180 }, anchorOf('top'));
    near(top.x, 200);
    near(top.y, 200);
  });

  it('45°: 右辺の真ん中 = 中心 + (w/2)(cos45, sin45)', () => {
    const p = anchorPoint({ ...r, rot: 45 }, anchorOf('right'));
    const k = Math.SQRT1_2 * 100;
    near(p.x, 200 + k);
    near(p.y, 150 + k);
  });

  it('15°: 右辺の真ん中', () => {
    const p = anchorPoint({ ...r, rot: 15 }, anchorOf('right'));
    const t = (15 * Math.PI) / 180;
    near(p.x, 200 + 100 * Math.cos(t));
    near(p.y, 150 + 100 * Math.sin(t));
  });

  it('0 / rot 無し / rot: 0 は今までと同じ座標(1 バイトも変わらない)', () => {
    const base = anchorPoint(r, anchorOf('right', 1, 4));
    expect(base).toEqual({ x: 300, y: 125 });
    expect(anchorPoint({ ...r, rot: 0 }, anchorOf('right', 1, 4))).toEqual(base);
  });

  it('辺の分数は付箋の中の向き: 回しても right@1/4 は右辺の上から 1/4(90° なら画面の下側で、左寄りでなく右から 1/4)', () => {
    // 回す前 right@1/4 = (300, 125)。中心 (200,150) からの差 (100,-25) を 90° 回すと (25, 100)
    const p = anchorPoint({ ...r, rot: 90 }, anchorOf('right', 1, 4));
    near(p.x, 225);
    near(p.y, 250);
  });

  it('自動で選ぶ辺は回した端点で比べる: 右の付箋 b の左辺に向かう a は、a を 180° 回すと a の「左辺」から出る', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    const b = { x: 300, y: 0, w: 100, h: 100 };
    const plain = placeLineOf(a, b);
    expect(plain.from.edge).toBe('right');
    const turned = placeLineOf({ ...a, rot: 180 }, b);
    // 180° 回した a の「左辺」が画面の右側に来る → いちばん近い辺は left
    expect(turned.from.edge).toBe('left');
    near(turned.x1, 100);
    near(turned.y1, 50);
  });

  it('外接四角: 90° で幅と高さが入れ替わる / 45° で正方形になる', () => {
    const b90 = rotatedBounds(r, 90);
    near(b90.w, 100);
    near(b90.h, 200);
    near(b90.x, 150);
    near(b90.y, 50);
    const b45 = rotatedBounds(r, 45);
    near(b45.w, (200 + 100) * Math.SQRT1_2);
    near(b45.h, (200 + 100) * Math.SQRT1_2);
    expect(rotatedBounds(r, 0)).toBe(r);
  });

  it('4 つの角は中心から等距離のまま回る', () => {
    const cs = rotatedCorners(r, 45);
    const d = Math.hypot(100, 50);
    for (const c of cs) near(Math.hypot(c.x - 200, c.y - 150), d);
  });
});

describe('辺の判定と離した先の当たり(点を逆に回す)', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 }; // 中心 (200,150)

  it('🔴 90° 回した付箋: 画面の下側(中心の真下)に乗せた点は、付箋の中の「右辺」', () => {
    // 画面の (200, 240) は中心から真下 90。回す前の座標へ戻すと (290, 150) = 右辺の近く
    expect(nearestEdge({ ...r, rot: 90 }, 200, 240)).toBe('right');
    // 回していなければ、同じ点は下辺
    expect(nearestEdge(r, 200, 240)).toBe('bottom');
  });

  it('逆回しは回しの逆: 回した点を戻すと元に戻る', () => {
    const p = anchorPoint({ ...r, rot: 33 }, anchorOf('top', 1, 4));
    const q = unrotatePoint(r, 33, p.x, p.y);
    const o = anchorPoint(r, anchorOf('top', 1, 4));
    near(q.x, o.x, 1e-9);
    near(q.y, o.y, 1e-9);
  });

  it('🔴 離した先: 45° 回した付箋の「回す前の角」は外れ、「回した後の角の内側」は当たる', () => {
    const sq = { x: 0, y: 0, w: 100, h: 100, rot: 45 }; // 中心 (50,50)
    const cands = [{ item: 'a', rect: sq, z: 0 }];
    // 回す前の左上の角 (2, 2) は、45° 回すと画面ではひし形の外
    expect(topPlaceAt(cands, 2, 2)).toBeNull();
    // ひし形の頂点 (50, 50 - 70) の少し内側は当たる
    expect(topPlaceAt(cands, 50, 50 - 60)?.item).toBe('a');
    // 回していなければ、回す前の角は当たる
    expect(topPlaceAt([{ item: 'a', rect: { ...sq, rot: 0 }, z: 0 }], 2, 2)?.item).toBe('a');
  });
});

describe('回した付箋の角の伸縮(resizeRotated)', () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };
  const min = { w: 120, h: 40 };

  /** 回した後の左上の角(画面)── 伸縮で動かないはずの点 */
  const topLeft = (b: { x: number; y: number; w: number; h: number }, deg: number) => rotatedCorners(b, deg)[0]!;

  it('回していない(0°)は、dx dy をそのまま足す', () => {
    expect(resizeRotated(start, 0, 50, 30, min)).toEqual({ x: 100, y: 100, w: 250, h: 130 });
  });

  it.each([15, 45, 90, 180, 270, 333])('🔴 %i°: 反対側の角(左上)が画面で動かない', (deg) => {
    const out = resizeRotated(start, deg, 37, -12, min);
    const before = topLeft(start, deg);
    const after = topLeft(out, deg);
    near(after.x, before.x, 1e-6);
    near(after.y, before.y, 1e-6);
  });

  it('🔴 90°: 画面で右へ引くと、付箋の向きでは「高さ」が逆に縮む(右 = 付箋の下向きではなく上向き)', () => {
    // 90° 回した付箋の「付箋の右向き」は画面の下。画面の下へ 40 引くと幅が 40 伸びる
    const down = resizeRotated(start, 90, 0, 40, min);
    near(down.w, 240);
    near(down.h, 100);
    // 画面の右へ 40 引くと、付箋の向きでは「下」の逆(= 上)なので高さが 40 縮む
    const right = resizeRotated(start, 90, 40, 0, min);
    near(right.w, 200);
    near(right.h, 60);
  });

  it('下限で止まる: 引き過ぎても幅・高さは下限、左上の角は飛ばない', () => {
    const out = resizeRotated(start, 30, -1000, -1000, min);
    expect(out.w).toBe(120);
    expect(out.h).toBe(40);
    const before = topLeft(start, 30);
    const after = topLeft(out, 30);
    // 0 未満へ丸めた分(x y が負になる場合)以外は動かない ── ここでは 0 以上のまま収まる
    if (out.x > 0 && out.y > 0) {
      near(after.x, before.x, 1e-6);
      near(after.y, before.y, 1e-6);
    }
  });

  it('x y は 0 を下回らない(記法の下限)', () => {
    const near0 = { x: 0, y: 0, w: 200, h: 100 };
    const out = resizeRotated(near0, 45, -60, 90, min);
    expect(out.x).toBeGreaterThanOrEqual(0);
    expect(out.y).toBeGreaterThanOrEqual(0);
  });
});
