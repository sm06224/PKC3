/** @vitest-environment node */
/**
 * P7b 段⑩: ランチャーのタイル(並べ方と、タイルにする / しないの判断)。
 *
 * 🔴 これは「新機能」ではなく**取り込んだデータの到達不能の解消**なので、
 * 判断基準は「PKC2 で見えていたものが、同じ順で見えるか」である。
 */
import { describe, expect, it } from 'vitest';
import {
  buildTiles,
  isLaunchableUrl,
  sortTiles,
  tileFrom,
  type LauncherTile,
} from '../../src/features/launcher/tiles';

/** attachment の body(frontmatter だけ持つ)を組む。 */
function body(fields: Record<string, string | number | boolean>): string {
  const lines = Object.entries(fields).map(([k, v]) =>
    typeof v === 'string' ? `${k}: ${v}` : `${k}: ${String(v)}`,
  );
  return `---\n${lines.join('\n')}\n---\n`;
}

describe('タイルにするか', () => {
  it('🔴 アプリとして登録された添付はタイルになる', () => {
    const tile = tileFrom({
      lid: 'a',
      title: '電卓',
      body: body({
        'attachment.registered_as_app': true,
        'attachment.asset_key': 'k1',
        'attachment.mime': 'text/html',
      }),
    });
    expect(tile).toMatchObject({ lid: 'a', title: '電卓', kind: 'app', assetKey: 'k1' });
  });

  it('🔴 URL タイルは飛び先を持つ', () => {
    const tile = tileFrom({
      lid: 'b',
      title: '検索',
      body: body({
        'attachment.registered_as_app': true,
        'attachment.launcher_url': 'https://example.com/x',
      }),
    });
    expect(tile).toMatchObject({ kind: 'url', url: 'https://example.com/x' });
  });

  it('🔴 素の添付はタイルにしない(画像まで並んだら使い物にならない)', () => {
    expect(
      tileFrom({
        lid: 'c',
        title: '写真.png',
        body: body({ 'attachment.asset_key': 'k2', 'attachment.mime': 'image/png' }),
      }),
    ).toBeNull();
  });

  it('🔴 bytes を指していない「アプリ」はタイルにしない(押しても開けない)', () => {
    expect(
      tileFrom({ lid: 'd', title: '壊れ', body: body({ 'attachment.registered_as_app': true }) }),
    ).toBeNull();
  });

  it.each([
    ['https://example.com', true],
    ['http://example.com/a?b=1', true],
    ['javascript:alert(1)', false],
    ['data:text/html,<script>', false],
    ['file:///etc/passwd', false],
    ['', false],
  ])('🔴 開ける URL か: %s → %s', (url, ok) => {
    // ⚠ `javascript:` を通すと、タイルを踏んだ瞬間にアプリの文脈で任意コードが動く
    expect(isLaunchableUrl(url)).toBe(ok);
  });

  it('🔴 開けない URL のタイルは出さない(押しても何も起きないタイルを作らない)', () => {
    expect(
      tileFrom({
        lid: 'e',
        title: '危険',
        body: body({
          'attachment.registered_as_app': true,
          'attachment.launcher_url': 'javascript:alert(1)',
        }),
      }),
    ).toBeNull();
  });
});

describe('並べ方 ── PKC2 と同じ順で見える', () => {
  const t = (lid: string, group: string, order?: number): LauncherTile => ({
    lid,
    title: lid,
    group,
    kind: 'url',
    url: 'https://e.example',
    ...(order === undefined ? {} : { order }),
  });

  it('🔴 グループ名の無いものが**先頭**(移行後に「いつものタイル」が下に消えない)', () => {
    const out = sortTiles([t('x', 'ツール'), t('y', ''), t('z', 'あ')]);
    expect(out.map((o) => o.lid)).toEqual(['y', 'z', 'x']);
  });

  it('🔴 グループの中は app_order 順', () => {
    const out = sortTiles([t('c', 'G', 3), t('a', 'G', 1), t('b', 'G', 2)]);
    expect(out.map((o) => o.lid)).toEqual(['a', 'b', 'c']);
  });

  it('🔴 app_order の無いものは**末尾**で、元の順を保つ(安定)', () => {
    const out = sortTiles([t('p', 'G'), t('q', 'G'), t('r', 'G', 1)]);
    expect(out.map((o) => o.lid)).toEqual(['r', 'p', 'q']);
  });

  it('読めないものは黙って落として、残りは並ぶ', () => {
    const tiles = buildTiles([
      { lid: '1', title: 'ok', body: body({ 'attachment.registered_as_app': true, 'attachment.asset_key': 'k' }) },
      { lid: '2', title: 'ng', body: '本文だけで frontmatter が無い' },
      { lid: '3', title: 'url', body: body({ 'attachment.launcher_url': 'https://e.example' }) },
    ]);
    expect(tiles.map((x) => x.lid)).toEqual(['1', '3']);
  });
});
