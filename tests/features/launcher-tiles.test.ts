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
  dualTile,
  DUAL_TILE_LID,
  isLaunchableUrl,
  officeTile,
  OFFICE_TILE_LID,
  scheduleTile,
  sortTiles,
  tileFrom,
  tileSelectsEntry,
  withBuiltinTiles,
  MANUAL_TILE_LID,
  SCHEDULE_TILE_LID,
  CONTACTS_TILE_LID,
  contactsTile,
  SEARCH_TILE_LID,
  searchTile,
  manualTile,
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

describe('組み込みタイルの合流 (#148)', () => {
  const entryTiles: LauncherTile[] = [
    { lid: 'a1', title: '見積', group: '', kind: 'app', assetKey: 'k1' },
    { lid: 'a2', title: '外部', group: '道具', kind: 'url', url: 'https://x.test/' },
  ];

  /**
   * 🔴 **並びは固定**(#241。user 指摘 2026-08-19「2 ペインファイラはアプリとして
   * Office のように組み込みの導線を用意しろ」)。
   * ⚠ 2 ペインは**アプリに最初から在る**ので先頭、Office は**入れた端末だけ**なので
   *   その次 ── 入れたり消したりで 2 ペインの位置が動かない向きに並べる。
   */
  it('組み込みは 2 ペイン → 予定表 → 連絡先 → 探す → Office → マニュアルの順で、既定グループの先頭に付く', () => {
    const merged = withBuiltinTiles(entryTiles, { office: true });
    expect(merged[0]).toEqual({
      lid: DUAL_TILE_LID,
      title: '2 ペインで整理',
      group: '',
      kind: 'dual',
    });
    /**
     * ⚠ **カレンダー / やることの板は #292 段⑤ でここから外れた**(2026-08-23)──
     *   あの 2 つは「アプリ」ではなく**ノートの見方**だったので、左の列の
     *   「予定」タブへ引っ越した。
     * 🔴 **予定表は #673 段②(user 裁定 2026-09-04「アプリの基本は別窓」)で
     *   別窓の入口として戻った** ── 左のタブは残したまま、2 つ目の入口である。
     *   Office より前(アプリに最初から在るものを先に ── Office の有無で位置が動かない)。
     */
    expect(merged[1]).toEqual({
      lid: SCHEDULE_TILE_LID,
      title: '予定表',
      group: '',
      kind: 'schedule',
    });
    // ⚠ 連絡先(#278 段③)は予定表の次 ── 同じく「アプリに最初から在る」側
    expect(merged[2]).toEqual({
      lid: CONTACTS_TILE_LID,
      title: '連絡先',
      group: '',
      kind: 'contacts',
    });
    // ⚠ 探す(#680)は連絡先の次 ── 同じく「アプリに最初から在る」側(Office より前)
    expect(merged[3]).toEqual({
      lid: SEARCH_TILE_LID,
      title: '探す',
      group: '',
      kind: 'search',
    });
    expect(merged[4]).toEqual({
      lid: OFFICE_TILE_LID,
      title: 'Office',
      group: '',
      kind: 'office',
    });
    /**
     * 🔴 **マニュアルは最後**(#645、2026-08-31)── 2 ペインと Office は
     *   「作業する所」で、マニュアルは「読む所」である。読み物の有無で
     *   作業の口の位置を動かさない(上の「位置が動かない向きに並べる」と同じ判断)。
     */
    expect(merged[5]).toEqual({
      lid: MANUAL_TILE_LID,
      title: 'マニュアル',
      group: '',
      kind: 'manual',
    });
    // ⚠ entry 由来の並びには触らない(合流は前置だけ)
    expect(merged.slice(6)).toEqual(entryTiles);
  });

  it('🔴 Office が入っていなくても、最初から在るものは出る(位置も動かない)', () => {
    const merged = withBuiltinTiles(entryTiles, { office: false });
    expect(merged[0]?.lid, 'Office の有無で 2 ペインの位置が動いた').toBe(DUAL_TILE_LID);
    expect(merged[1]?.lid, 'Office の有無で予定表の位置が動いた').toBe(SCHEDULE_TILE_LID);
    expect(merged[2]?.lid, 'Office の有無で連絡先の位置が動いた').toBe(CONTACTS_TILE_LID);
    expect(merged[3]?.lid, 'Office の有無で探すの位置が動いた').toBe(SEARCH_TILE_LID);
    expect(merged[4]?.lid, 'Office の有無でマニュアルの位置が動いた').toBe(MANUAL_TILE_LID);
    expect(merged.slice(5)).toEqual(entryTiles);
    // ⚠ 「同じ長さ」だけでは足して 1 枚消す実装と区別がつかない ── kind で見る
    expect(merged.some((t) => t.kind === 'office')).toBe(false);
  });

  /**
   * 🔴 **組み込みは entry を持たない**(#645)。⚠ `BUILTIN_KINDS` に足し忘れると、
   * 押した瞬間に**存在しない lid** が選択に入り、右の列が「見つからない」になる。
   */
  it('🔴 マニュアルのタイルは entry の選択を立てない', () => {
    expect(tileSelectsEntry(manualTile()), '存在しない lid を選択に入れている').toBe(false);
    // ⚠ **対照群** ── entry 由来のタイルは立てる(規則そのものが生きている)
    expect(
      tileSelectsEntry({ lid: 'n1', title: 'x', group: '', kind: 'app', assetKey: 'a' }),
      '規則が死んでいる(何も選ばなくなった)',
    ).toBe(true);
  });

  it('entry が 0 件でも組み込みだけで面が成立する', () => {
    const merged = withBuiltinTiles([], { office: true });
    // ⚠ 予定表(#673 段②)は 2 ペインの次、連絡先(#278 段③)はその次
    expect(merged.map((t) => t.kind)).toEqual([
      'dual',
      'schedule',
      'contacts',
      'search',
      'office',
      'manual',
    ]);
    // ⚠ Office を入れていない端末でも、面は空にならない
    expect(withBuiltinTiles([], { office: false }).map((t) => t.kind)).toEqual([
      'dual',
      'schedule',
      'contacts',
      'search',
      'manual',
    ]);
  });

  /**
   * ⚠ 組み込みは entry を持たない ── 押して選択を立てると右の列が
   * 「見つからない」になる(存在しない lid を `selectedLid` に入れない)。
   */
  it('🔴 組み込みタイルは entry の選択を立てない', () => {
    expect(tileSelectsEntry(dualTile()), '2 ペインで選択が立つ').toBe(false);
    // ⚠ 予定表(#673 段②)── `BUILTIN_KINDS` に足し忘れると、右の列が「見つからない」になる
    expect(tileSelectsEntry(scheduleTile()), '予定表で選択が立つ').toBe(false);
    expect(tileSelectsEntry(contactsTile()), '連絡先で選択が立つ').toBe(false);
    expect(tileSelectsEntry(searchTile()), '探すで選択が立つ').toBe(false);
    expect(tileSelectsEntry(officeTile())).toBe(false);
    expect(tileSelectsEntry(entryTiles[0]!), 'entry 由来まで立たなくなった').toBe(true);
  });

  it('tileSelectsEntry ── 組み込みだけ選択を立てない', () => {
    expect(tileSelectsEntry(officeTile())).toBe(false);
    for (const t of entryTiles) expect(tileSelectsEntry(t)).toBe(true);
  });
});
