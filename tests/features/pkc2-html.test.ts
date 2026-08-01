/** @vitest-environment happy-dom */
/**
 * P6b: PKC2 単一 HTML の受理(設計 doc §2)。
 * 要点は「壊れた入力を**静かに受理しない**」── 読めたつもりで 0 件が最悪。
 */
import { describe, expect, it } from 'vitest';
import { parsePkc2Html, Pkc2ParseError } from '../../src/features/import/pkc2-html';
import { detectPkc2Format, sniffMagic } from '../../src/features/import/detect-format';

/** PKC2 の export と同じ骨格(slot id と `<\/script` 退避)を持つ最小 HTML。 */
function pkc2Html(
  payload: unknown,
  meta: Record<string, unknown> = { app: 'pkc2', schema: 1 },
): string {
  const data = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  return `<!doctype html><html><head>
    <script id="pkc-meta" type="application/json">${JSON.stringify(meta)}</script>
  </head><body>
    <script id="pkc-data" type="application/json">${data}</script>
  </body></html>`;
}

const minimalContainer = {
  meta: { container_id: 'c1', title: 'テスト' },
  entries: [{ lid: 'e1', title: 'ノート', archetype: 'text', body: '# 本文\n' }],
  relations: [],
};

describe('parsePkc2Html (P6b)', () => {
  it('container と export_meta を取り出す', () => {
    const html = pkc2Html({
      container: minimalContainer,
      export_meta: { mode: 'full', mutability: 'editable', asset_encoding: 'gzip+base64' },
    });
    const got = parsePkc2Html(html);
    expect((got.container as typeof minimalContainer).entries).toHaveLength(1);
    expect(got.exportMeta).toMatchObject({ mode: 'full', assetEncoding: 'gzip+base64' });
  });

  it('asset_encoding 未指定は base64 とみなす(PKC2 の既定)', () => {
    const html = pkc2Html({ container: minimalContainer, export_meta: {} });
    expect(parsePkc2Html(html).exportMeta.assetEncoding).toBe('base64');
  });

  it('本文に `</script>` を含んでも壊れない(退避の復元)', () => {
    const c = {
      ...minimalContainer,
      entries: [{ lid: 'e1', title: 'x', archetype: 'text', body: '<script>alert(1)</script>\n' }],
    };
    const got = parsePkc2Html(pkc2Html({ container: c, export_meta: {} }));
    const entries = (got.container as typeof c).entries;
    expect(entries[0]!.body).toBe('<script>alert(1)</script>\n');
  });

  it('script は実行されない(構文解析のみ)', () => {
    const marker = '__pkc_import_should_not_run__';
    const html = `<!doctype html><html><head>
      <script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script>
      <script>globalThis.${marker} = true;</script>
      </head><body>
      <script id="pkc-data" type="application/json">${JSON.stringify({ container: minimalContainer, export_meta: {} })}</script>
      </body></html>`;
    parsePkc2Html(html);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('PKC2 でない / 未対応 schema / 壊れた JSON は理由付きで失敗する', () => {
    expect(() => parsePkc2Html('<html><body>ただの HTML</body></html>')).toThrow(
      /#pkc-meta が無い/,
    );
    expect(() =>
      parsePkc2Html(pkc2Html({ container: minimalContainer }, { app: 'other', schema: 1 })),
    ).toThrow(/PKC2 のファイルではありません/);
    expect(() =>
      parsePkc2Html(pkc2Html({ container: minimalContainer }, { app: 'pkc2', schema: 2 })),
    ).toThrow(/未対応の PKC2 schema/);
    // 「読めるところだけ読む」をしない ── 形が違えば必ず throw
    expect(() => parsePkc2Html(pkc2Html({ container: { meta: {} } }))).toThrow(
      /形が想定と違います/,
    );
    expect(() => parsePkc2Html(pkc2Html({ export_meta: {} }))).toThrow(/コンテナが空です/);
    expect(() => parsePkc2Html(`<html><head>
      <script id="pkc-meta" type="application/json">{"app":"pkc2","schema":1}</script>
      </head><body><script id="pkc-data" type="application/json">{ 壊れた</script></body></html>`),
    ).toThrow(Pkc2ParseError);
  });
});

describe('detectPkc2Format (P6b)', () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it('magic で ZIP / テキストを見分ける(拡張子を信じない)', () => {
    expect(sniffMagic(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(sniffMagic(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe('zip');
    expect(sniffMagic(enc('  \n<!doctype html>'))).toBe('text');
    expect(sniffMagic(enc('{"a":1}'))).toBe('text');
    expect(sniffMagic(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBe('unknown');
  });

  it('ZIP は manifest.format が正 ── 未知の format は受理しない', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(detectPkc2Format(zip, 'pkc2-package')).toBe('package');
    expect(detectPkc2Format(zip, 'pkc2-entry-bundle')).toBe('entry-bundle');
    expect(detectPkc2Format(zip, 'some-other-tool')).toBe('unknown');
    expect(detectPkc2Format(zip, null, 'backup.pkc2.zip')).toBe('unknown'); // 拡張子で推測しない
  });

  it('拡張子が嘘でも中身で決まる', () => {
    const html = enc('<!doctype html><html>…');
    expect(detectPkc2Format(html, null, 'container.zip')).toBe('html');
    const binary = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG
    expect(detectPkc2Format(binary, null, 'export.html')).toBe('unknown');
  });
});
