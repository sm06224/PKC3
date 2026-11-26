/** @vitest-environment node */
/**
 * ` ```3d ` のシーン記述(v4.0 PR-12)。例外を投げず、日本語の理由で断る・範囲に収めることを守る。
 */
import { describe, expect, it } from 'vitest';
import {
  SCENE_MAX_OBJECTS,
  parse3dSceneSpec,
  primitiveEdges,
  projectScene2d,
  rotateXYZ,
  sceneBounds,
  type SceneSpec,
} from '@features/viewer3d/scene-spec';
import { fitBoundsToOrbit } from '@features/viewer3d/orbit-math';

function ok(src: string): SceneSpec {
  const r = parse3dSceneSpec(src);
  if (!r.ok) throw new Error(`読めなかった: ${r.error}`);
  return r.spec;
}
function err(src: string): string {
  const r = parse3dSceneSpec(src);
  if (r.ok) throw new Error('読めてしまった');
  return r.error;
}

describe('parse3dSceneSpec', () => {
  it('既定値が入る', () => {
    const s = ok('{"objects":[{"type":"box"}]}');
    expect(s.grid).toBe(true);
    expect(s.axes).toBe(false);
    expect(s.wireframe).toBe(false);
    expect(s.background).toBe('theme');
    expect(s.height).toBe(360);
    expect(s.camera.fov).toBe(45);
    expect(s.modelKey).toBeUndefined();
    expect(s.objects[0]).toMatchObject({ type: 'box', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], size: [1, 1, 1], opacity: 1, wireframe: false });
  });

  it('指定を読む(色の #RGB は広げる・scale / size は数 1 つでも)', () => {
    const s = ok(
      JSON.stringify({
        objects: [{ type: 'torus', position: [1, 2, 3], rotation: [90, 0, 45], scale: 2, size: [1, 2, 3], color: '#F0a', wireframe: true, opacity: 0.5, label: '輪' }],
        camera: { position: [5, 5, 5], target: [0, 1, 0], fov: 60 },
        grid: false,
        axes: true,
        wireframe: true,
        background: '#112233',
        height: 480,
      }),
    );
    expect(s.objects[0]).toMatchObject({ type: 'torus', position: [1, 2, 3], rotation: [90, 0, 45], scale: [2, 2, 2], size: [1, 2, 3], color: '#ff00aa', wireframe: true, opacity: 0.5, label: '輪' });
    expect(s.camera).toEqual({ position: [5, 5, 5], target: [0, 1, 0], fov: 60 });
    expect([s.grid, s.axes, s.wireframe, s.background, s.height]).toEqual([false, true, true, '#112233', 480]);
  });

  it('範囲に収める(fov 15〜100・height 200〜720・opacity 0.05〜1)', () => {
    const s = ok('{"objects":[{"type":"box","opacity":0},{"type":"box","opacity":7}],"camera":{"fov":1},"height":9999}');
    expect(s.camera.fov).toBe(15);
    expect(s.height).toBe(720);
    expect(s.objects.map((o) => o.opacity)).toEqual([0.05, 1]);
    expect(ok('{"objects":[],"camera":{"fov":500},"height":3}').camera.fov).toBe(100);
    expect(ok('{"objects":[],"height":3}').height).toBe(200);
  });

  it('model は asset:鍵 だけ', () => {
    expect(ok('{"model":"asset:ast-abc_123"}').modelKey).toBe('ast-abc_123');
    expect(ok('{"model":" asset:k1 ","objects":[{"type":"sphere"}]}').modelKey).toBe('k1');
  });

  it('🔴 外部 URL・相対パス・data: の model を断る', () => {
    for (const m of ['https://example.com/a.glb', 'http://x/a.stl', '//x/a.glb', './a.obj', 'a.glb', 'data:model/gltf-binary;base64,AA', 'asset:https://x/a.glb', 'asset:../a.glb', 'asset:']) {
      const e = err(JSON.stringify({ model: m }));
      expect(e, m).toMatch(/model/);
    }
    expect(err('{"model":"https://example.com/a.glb"}')).toContain('外部の URL');
  });

  it('🔴 書式の誤りは例外を投げず日本語の理由で返す', () => {
    expect(err('{')).toContain('JSON が読めません');
    expect(err('[]')).toContain('{ … }');
    expect(err('{}')).toContain('model か objects');
    expect(err('{"objects":{}}')).toContain('配列');
    expect(err('{"objects":[{"type":"teapot"}]}')).toContain('box / sphere');
    expect(err('{"objects":[{"type":"box","position":[1,2]}]}')).toContain('[x, y, z]');
    expect(err('{"objects":[{"type":"box","color":"red"}]}')).toContain('#RGB');
    expect(err('{"objects":[{"type":"box","position":[1,"a",2]}]}')).toContain('数');
    expect(err('{"objects":[],"background":"url(x)"}')).toContain('#RGB');
    expect(err('{"objects":[],"grid":"yes"}')).toContain('true か false');
  });

  it(`🔴 オブジェクトは ${SCENE_MAX_OBJECTS} 個まで`, () => {
    const many = (n: number): string => JSON.stringify({ objects: Array.from({ length: n }, () => ({ type: 'box' })) });
    expect(ok(many(SCENE_MAX_OBJECTS)).objects).toHaveLength(SCENE_MAX_OBJECTS);
    expect(err(many(SCENE_MAX_OBJECTS + 1))).toContain('多すぎます');
  });
});

describe('2D の簡易表示', () => {
  it('立体ごとに線分が出る', () => {
    const s = ok(JSON.stringify({ objects: ['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus'].map((type) => ({ type })) }));
    const counts = s.objects.map((o) => primitiveEdges(o).length);
    expect(counts[0]).toBe(12); // 箱の辺
    expect(counts[4]).toBe(4); // 板の辺
    for (const c of counts) expect(c).toBeGreaterThan(0);
  });

  it('回転は three の Euler XYZ と同じ合成(z → y → x の順に当てる)', () => {
    const p = rotateXYZ([1, 0, 0], [0, 0, 90]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(1);
    // x 軸 90° → y 軸 90°: (0,1,0) を Rz なし → Ry で x→-z、その後 Rx
    const q = rotateXYZ([0, 1, 0], [90, 0, 0]);
    expect(q[1]).toBeCloseTo(0);
    expect(q[2]).toBeCloseTo(1);
  });

  it('外接箱は位置と大きさを反映する', () => {
    const s = ok('{"objects":[{"type":"box","position":[10,0,0],"size":2}]}');
    const b = sceneBounds(s)!;
    expect(b.min[0]).toBeCloseTo(9);
    expect(b.max[0]).toBeCloseTo(11);
    expect(sceneBounds(ok('{"objects":[]}'))).toBeNull();
  });

  it('🔴 projectScene2d: 視点に収めた箱は画面の中に描かれる', () => {
    const s = ok('{"objects":[{"type":"box","color":"#ff0000"}]}');
    const b = sceneBounds(s)!;
    const orbit = fitBoundsToOrbit(b.min, b.max, 45, 400 / 300);
    const segs = projectScene2d(s, 400, 300, orbit);
    expect(segs).toHaveLength(12);
    for (const seg of segs) {
      for (const [x, y] of [[seg.x1, seg.y1], [seg.x2, seg.y2]] as const) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(400);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(300);
      }
      expect(seg.color).toBe('#ff0000');
    }
  });

  it('カメラの後ろの線は落とし、足した線(グリッド)は指定の色', () => {
    const s = ok('{"objects":[{"type":"box","position":[0,0,100]}]}');
    // 原点から -z 向きに見る(箱は真後ろ)
    const orbit = { target: [0, 0, -1] as const, radius: 1, theta: 0, phi: Math.PI / 2 };
    expect(projectScene2d(s, 100, 100, orbit)).toHaveLength(0);
    const withGrid = projectScene2d(ok('{"objects":[]}'), 100, 100, { target: [0, 0, 0], radius: 10, theta: 0.5, phi: 1 }, {
      extra: [{ a: [-1, 0, 0], b: [1, 0, 0], color: '' }],
      gridColor: '#123456',
    });
    expect(withGrid).toHaveLength(1);
    expect(withGrid[0]!.color).toBe('#123456');
  });
});
