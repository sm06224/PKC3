/** @vitest-environment node */
/**
 * 3D モデルの形式判定と「外へ取りに行かない」検査(v4.0 PR-12)。
 * 🔑 期待値は手で書く(実装の表を写さない ── `.claude/rules/verification.md` §1.10)。
 */
import { describe, expect, it } from 'vitest';
import {
  detect3dModelFormat,
  extractGlbJson,
  isAllowedLocal3dUrl,
  sniff3dModelFormat,
  validateLocalGltfJson,
} from '@features/viewer3d/model-format';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** 最小の GLB(JSON 塊だけ)。 */
function glb(json: string): Uint8Array {
  let body = enc(json);
  const pad = (4 - (body.length % 4)) % 4;
  if (pad) body = new Uint8Array([...body, ...new Array<number>(pad).fill(0x20)]);
  const out = new Uint8Array(12 + 8 + body.length);
  const v = new DataView(out.buffer);
  out.set(enc('glTF'), 0);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, body.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(body, 20);
  return out;
}

describe('detect3dModelFormat', () => {
  it('MIME が 3D を名乗れば、それに従う', () => {
    expect(detect3dModelFormat('model/gltf-binary')).toBe('glb');
    expect(detect3dModelFormat('model/gltf+json')).toBe('gltf');
    expect(detect3dModelFormat('model/stl')).toBe('stl');
    expect(detect3dModelFormat('application/sla')).toBe('stl');
    expect(detect3dModelFormat('model/obj')).toBe('obj');
    expect(detect3dModelFormat('MODEL/GLTF-BINARY; charset=binary')).toBe('glb');
  });

  it('🔴 ブラウザが渡す汎用の MIME でも、拡張子で 3D と分かる', () => {
    expect(detect3dModelFormat('text/plain', 'cube.obj')).toBe('obj');
    expect(detect3dModelFormat('text/plain', 'part.STL')).toBe('stl');
    expect(detect3dModelFormat('application/octet-stream', 'scene.glb')).toBe('glb');
    expect(detect3dModelFormat('', 'Scene.GLTF')).toBe('gltf');
    expect(detect3dModelFormat(null, 'dir/sub/model.Obj')).toBe('obj');
    expect(detect3dModelFormat(undefined, 'C:\\models\\a.stl')).toBe('stl');
    expect(detect3dModelFormat('application/json', 'a.gltf')).toBe('gltf');
  });

  it('3D でない物は null(名前だけ似ている物も)', () => {
    expect(detect3dModelFormat('text/plain', 'memo.txt')).toBeNull();
    expect(detect3dModelFormat('image/png', 'a.png')).toBeNull();
    expect(detect3dModelFormat('', '')).toBeNull();
    expect(detect3dModelFormat(null, null)).toBeNull();
    expect(detect3dModelFormat('', 'obj')).toBeNull(); // 拡張子ではない
    expect(detect3dModelFormat('', '.glb')).toBeNull(); // 隠しファイル名
    expect(detect3dModelFormat('', 'a.glb.txt')).toBeNull();
  });
});

describe('sniff3dModelFormat', () => {
  it('GLB の印', () => {
    expect(sniff3dModelFormat(glb('{"asset":{"version":"2.0"}}'))).toBe('glb');
  });
  it('バイナリ STL は長さの整合で見る', () => {
    const bytes = new Uint8Array(84 + 50 * 2);
    new DataView(bytes.buffer).setUint32(80, 2, true);
    expect(sniff3dModelFormat(bytes, bytes.length)).toBe('stl');
    // 長さが合わなければ STL と言わない
    expect(sniff3dModelFormat(bytes, bytes.length + 1)).toBeNull();
  });
  it('ASCII STL / glTF JSON / OBJ', () => {
    expect(sniff3dModelFormat(enc('solid cube\n facet normal 0 0 1\n'))).toBe('stl');
    expect(sniff3dModelFormat(enc('{ "asset": { "version": "2.0" } }'))).toBe('gltf');
    expect(sniff3dModelFormat(enc('# made by hand\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'))).toBe('obj');
  });
  it('ただの字・JSON は 3D と言わない', () => {
    expect(sniff3dModelFormat(enc('こんにちは'))).toBeNull();
    expect(sniff3dModelFormat(enc('{"a":1}'))).toBeNull();
    expect(sniff3dModelFormat(enc('solid state drive'))).toBeNull();
    expect(sniff3dModelFormat(new Uint8Array(0))).toBeNull();
  });
});

describe('isAllowedLocal3dUrl', () => {
  it('安全な data: だけ通す', () => {
    expect(isAllowedLocal3dUrl('data:application/octet-stream;base64,AAAA')).toBe(true);
    expect(isAllowedLocal3dUrl('data:application/gltf-buffer;base64,AAAA')).toBe(true);
    expect(isAllowedLocal3dUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedLocal3dUrl('DATA:IMAGE/JPEG;base64,AAAA')).toBe(true);
  });
  it('🔴 危ない data: を断る', () => {
    expect(isAllowedLocal3dUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAllowedLocal3dUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe(false);
    expect(isAllowedLocal3dUrl('data:,hello')).toBe(false);
    expect(isAllowedLocal3dUrl('data:application/javascript,x')).toBe(false);
    expect(isAllowedLocal3dUrl('data:image/png')).toBe(false); // カンマ無し
    expect(isAllowedLocal3dUrl('javascript:alert(1)')).toBe(false);
  });
  it('🔴 外部・相対・file: を断る', () => {
    for (const u of ['http://example.com/a.bin', 'https://example.com/a.png', '//example.com/a.bin', 'a.bin', './tex/a.png', '../a.bin', '/a.bin', 'file:///etc/passwd', '']) {
      expect(isAllowedLocal3dUrl(u), u).toBe(false);
    }
  });
  it('blob: は許した物だけ', () => {
    const ok = 'blob:http://localhost/1111';
    expect(isAllowedLocal3dUrl(ok)).toBe(false);
    expect(isAllowedLocal3dUrl(ok, new Set([ok]))).toBe(true);
    expect(isAllowedLocal3dUrl('blob:http://localhost/2222', new Set([ok]))).toBe(false);
  });
});

describe('validateLocalGltfJson', () => {
  it('埋め込みだけの glTF は通す(uri の無い項目も)', () => {
    const doc = {
      asset: { version: '2.0' },
      buffers: [{ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }, { byteLength: 8 }],
      images: [{ uri: 'data:image/png;base64,iVBO' }, { bufferView: 0, mimeType: 'image/png' }],
    };
    expect(validateLocalGltfJson(JSON.stringify(doc))).toEqual({ ok: true });
  });
  it('🔴 外部の .bin・画像・URL を理由つきで断る', () => {
    const cases = [
      { buffers: [{ uri: 'scene.bin' }] },
      { buffers: [{ uri: 'https://example.com/scene.bin' }] },
      { images: [{ uri: 'textures/a.png' }] },
      { images: [{ uri: '//cdn.example.com/a.png' }] },
      { buffers: [{ uri: 'data:application/octet-stream;base64,AA' }], images: [{ uri: 'http://x/a.jpg' }] },
    ];
    for (const c of cases) {
      const r = validateLocalGltfJson(JSON.stringify({ asset: { version: '2.0' }, ...c }));
      expect(r.ok, JSON.stringify(c)).toBe(false);
      if (!r.ok) expect(r.reason).toContain('外部');
    }
  });
  it('壊れた JSON・形の違いも断る(例外を投げない)', () => {
    expect(validateLocalGltfJson('{').ok).toBe(false);
    expect(validateLocalGltfJson('[]').ok).toBe(false);
    expect(validateLocalGltfJson('{"buffers":{}}').ok).toBe(false);
    expect(validateLocalGltfJson('{"buffers":[{"uri":1}]}').ok).toBe(false);
  });
});

describe('extractGlbJson', () => {
  it('JSON 塊を取り出す', () => {
    const json = '{"asset":{"version":"2.0"},"buffers":[{"uri":"x.bin"}]}';
    expect(extractGlbJson(glb(json))?.trim()).toBe(json);
    expect(validateLocalGltfJson(extractGlbJson(glb(json))!).ok).toBe(false);
  });
  it('壊れた GLB は null', () => {
    expect(extractGlbJson(enc('glTF'))).toBeNull();
    expect(extractGlbJson(enc('not a glb at all, really'))).toBeNull();
  });
});
