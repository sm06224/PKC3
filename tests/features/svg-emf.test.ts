/** @vitest-environment node */
/**
 * 🔴 **図をベクタ(EMF)で書き出す**(#238。user 指示 2026-08-17
 * 「**フローチャートのようないじれそうなものは emf とか wmf にして欲しい**」)。
 *
 * ⚠ **バイナリは、間違えても例外を出さない。** 誰も読めない file が静かに出るだけである。
 * だからここは**出したバイト列を解き直して**中身を数える ── 「落ちなかった」を合格にしない。
 *
 * ⚠ ここが守る欠陥は、どれも 2026-08-17 に**実物で踏んだ**もの:
 * ① mermaid は色を `<style>` の**子孫セレクタ**で与える ── 解決に失敗すると**箱が真っ黒**
 *    (LibreOffice の SVG→EMF がまさにこれで、実測で黒くなった)
 * ② 矢尻の回転を上下反転しても **90° の矢だけは正しく見える** ── 斜めの矢で初めて出る
 * ③ `fill:none` を落とすと、曲線のエッジが**塗り潰される**
 */
import { describe, expect, it } from 'vitest';
import { svgToEmf, parsePath, parseTransform } from '../../src/features/export/svg-emf';

/** EMF を記録の並びへ解き直す(検査はここから数える)。 */
function records(bytes: Uint8Array): { type: number; at: number; size: number }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { type: number; at: number; size: number }[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    const type = dv.getUint32(at, true);
    const size = dv.getUint32(at + 4, true);
    if (size < 8) break;
    out.push({ type, at, size });
    at += size;
    if (type === 14) break;
  }
  return out;
}

const R = {
  HEADER: 1,
  MOVETOEX: 27,
  CREATEPEN: 38,
  CREATEBRUSH: 39,
  RECTANGLE: 43,
  LINETO: 54,
  EXTTEXTOUTW: 84,
  EOF: 14,
} as const;

/** GDI の 0x00bbggrr を `#rrggbb` の数へ戻す。 */
function rgbFromGdi(v: number): number {
  const b = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const r = v & 0xff;
  return (r << 16) | (g << 8) | b;
}

function brushColors(bytes: Uint8Array): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return records(bytes)
    .filter((r) => r.type === R.CREATEBRUSH)
    .filter((r) => dv.getUint32(r.at + 12, true) === 0) // BS_SOLID だけ(BS_NULL は塗らない)
    .map((r) => rgbFromGdi(dv.getUint32(r.at + 16, true)));
}

function penColors(bytes: Uint8Array): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return records(bytes)
    .filter((r) => r.type === R.CREATEPEN)
    .filter((r) => dv.getUint32(r.at + 12, true) !== 5) // PS_NULL は描かない
    .map((r) => rgbFromGdi(dv.getUint32(r.at + 24, true)));
}

/** 置いた文字を拾う(UTF-16LE)。 */
function texts(bytes: Uint8Array): string[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  for (const r of records(bytes)) {
    if (r.type !== R.EXTTEXTOUTW) continue;
    const nChars = dv.getUint32(r.at + 8 + 16 + 4 + 8 + 8, true);
    const off = dv.getUint32(r.at + 8 + 16 + 4 + 8 + 8 + 4, true);
    let s = '';
    for (let i = 0; i < nChars; i += 1) s += String.fromCharCode(dv.getUint16(r.at + off + i * 2, true));
    out.push(s);
  }
  return out;
}

/** mermaid と**同じ形**の最小の SVG(色はクラスで与える ── そこが要である)。 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120" id="d1">
<style>#d1 .node rect{fill:#f5f6f8;stroke:#cdd2d9;stroke-width:1px;}
#d1 .label text{fill:#16191d;text-anchor:middle;}
#d1 .flowchart-link{stroke:#59616b;fill:none;}
#d1 .marker{fill:#ff0000;stroke:#ff0000;}
@keyframes dash{to{stroke-dashoffset:0;}}</style>
<defs><marker id="pe" refX="5" refY="5" orient="auto" markerUnits="userSpaceOnUse">
<path class="marker" d="M 0 0 L 10 5 L 0 10 z"/></marker></defs>
<g class="node"><rect x="20" y="10" width="80" height="30"></rect>
<g class="label"><text x="60" y="30"><tspan>はじめ</tspan></text></g></g>
<path class="flowchart-link" d="M60,40 L100,80" marker-end="url(#pe)"/>
</svg>`;

describe('svgToEmf(#238)', () => {
  const out = svgToEmf(SVG);

  it('🔴 EMF として読める形になっている(署名・件数・大きさが揃う)', () => {
    const dv = new DataView(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength);
    expect(dv.getUint32(0, true), 'HEADER で始まっていない').toBe(R.HEADER);
    expect(dv.getUint32(40, true).toString(16), "署名が ' EMF' でない").toBe('464d4520');
    // ⚠ **申告した大きさと実バイト数が一致**する(ここがずれると読み手が途中で止まる)
    expect(dv.getUint32(48, true), 'nBytes が実バイト数と違う').toBe(out.bytes.length);
    const recs = records(out.bytes);
    expect(dv.getUint32(52, true), 'nRecords が実件数と違う').toBe(recs.length);
    expect(recs.at(-1)!.type, 'EOF で終わっていない').toBe(R.EOF);
  });

  it('🔴 **クラスで与えた色**が入る(ここを落とすと箱が真っ黒になる)', () => {
    // `#d1 .node rect{fill:#f5f6f8}` ── 子孫セレクタを解けないと拾えない
    expect(brushColors(out.bytes), '節点の塗りが CSS から来ていない').toContain(0xf5f6f8);
    expect(penColors(out.bytes), '節点の線が CSS から来ていない').toContain(0xcdd2d9);
    // エッジの線
    expect(penColors(out.bytes), 'エッジの線が CSS から来ていない').toContain(0x59616b);
  });

  it('🔴 `fill:none` のエッジを塗らない(曲線が塗り潰される)', () => {
    // ⚠ **矢尻とエッジの色を分けてある** ── 同じ色だと「矢尻が塗られている」に
    //    満たされて、この検査は**何も主張しない**(最初の稿でそうなっていた)
    expect(brushColors(out.bytes), 'エッジを塗っている').not.toContain(0x59616b);
    // 空振り防止 ── 矢尻のほうは**塗られている**(塗りの経路自体は生きている)
    expect(brushColors(out.bytes), '矢尻が塗られていない').toContain(0xff0000);
  });

  it('🔴 文字が UTF-16 で入る(ラベルが消えない)', () => {
    expect(texts(out.bytes)).toContain('はじめ');
    expect(out.counts.texts).toBeGreaterThan(0);
  });

  it('🔴 矢尻が**進行方向**を向く(上下反転は 90° では見抜けない)', () => {
    // このエッジは 45°(右下)。矢尻の頂点は、底辺の中点より**右下**に無ければならない
    const dv = new DataView(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength);
    /**
     * ⚠ **道(path)ごとに拾う。** 座標を全部集めて「終点の近く」で絞った 1 稿目は、
     * **エッジ自身の終点**が混ざって三角形が 4 点になり、頂点を取り違えた。
     */
    const paths: { x: number; y: number }[][] = [];
    let cur: { x: number; y: number }[] | null = null;
    for (const r of records(out.bytes)) {
      if (r.type === 59) cur = [];
      else if ((r.type === R.MOVETOEX || r.type === R.LINETO) && cur !== null) {
        cur.push({ x: dv.getInt32(r.at + 8, true) / 10, y: dv.getInt32(r.at + 12, true) / 10 });
      } else if (r.type === 60 && cur !== null) {
        paths.push(cur);
        cur = null;
      }
    }
    const tri = paths.find((ps) => ps.length === 3 && ps.every((p) => Math.hypot(p.x - 100, p.y - 80) < 12));
    expect(tri, '矢尻(3 点の道)が終点の近くに無い').toBeDefined();
    // 頂点 = 他の 2 点の中点から最も遠い点
    let apex = tri![0]!;
    let mx = 0;
    let my = 0;
    let far = -1;
    for (let i = 0; i < 3; i += 1) {
      const rest = tri!.filter((_, j) => j !== i);
      const cx = (rest[0]!.x + rest[1]!.x) / 2;
      const cy = (rest[0]!.y + rest[1]!.y) / 2;
      const d = Math.hypot(tri![i]!.x - cx, tri![i]!.y - cy);
      if (d > far) {
        far = d;
        apex = tri![i]!;
        mx = cx;
        my = cy;
      }
    }
    expect(apex.x, '矢尻が進行方向(右)を向いていない').toBeGreaterThan(mx);
    expect(apex.y, '矢尻が進行方向(下)を向いていない').toBeGreaterThan(my);
  });

  it('🔴 何も描けなかったら投げる(空の図を「書けた」と言わない)', () => {
    expect(() => svgToEmf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>')).toThrow();
    expect(() => svgToEmf('<html><body/></html>')).toThrow();
  });

  it('版面は viewBox を正とする(width が % のことがある)', () => {
    expect(out.widthPx).toBe(200);
    expect(out.heightPx).toBe(120);
  });
});

describe('parsePath', () => {
  it('相対命令(小文字)を絶対へ直す', () => {
    const subs = parsePath('M10,10 l10,0 l0,10 z');
    expect(subs).toHaveLength(1);
    expect(subs[0]!.segs.map((s) => s.to)).toEqual([
      { x: 20, y: 10 },
      { x: 20, y: 20 },
    ]);
    expect(subs[0]!.closed).toBe(true);
  });

  it('M のあとの座標は暗黙の L になる(mermaid が実際に出す形)', () => {
    const subs = parsePath('M0,0 10,10 20,0');
    expect(subs[0]!.segs).toHaveLength(2);
  });

  it('2 次(Q)は 3 次へ寄せる ── EMF は 3 次しか持てない', () => {
    const subs = parsePath('M0,0 Q10,0 10,10');
    expect(subs[0]!.segs[0]!.kind).toBe('bezier');
  });

  it('⚠ 円弧(A)は落とさず終点まで直線で結ぶ', () => {
    const subs = parsePath('M0,0 A5,5 0 0 1 10,10');
    expect(subs[0]!.segs).toEqual([{ kind: 'line', to: { x: 10, y: 10 } }]);
  });
});

describe('parseTransform', () => {
  it('translate と scale を合成する(先に書いたものが外側)', () => {
    expect(parseTransform('translate(10,20) scale(2)')).toEqual([2, 0, 0, 2, 10, 20]);
  });
  it('rotate は中心つきでも解ける', () => {
    const m = parseTransform('rotate(90 10 10)');
    // (10,0) は中心(10,10)まわりの 90° 回転で (20,10) へ行く
    const x = m[0] * 10 + m[2] * 0 + m[4];
    const y = m[1] * 10 + m[3] * 0 + m[5];
    expect(Math.round(x)).toBe(20);
    expect(Math.round(y)).toBe(10);
  });
  it('読めない指定は単位行列(落とさない)', () => {
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransform('skewX(10)')).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
