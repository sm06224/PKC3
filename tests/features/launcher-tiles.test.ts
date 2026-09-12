/** @vitest-environment node */
/**
 * P7b 段⑩: ランチャーのタイル(並べ方と、タイルにする / しないの判断)。
 *
 * 🔴 これは「新機能」ではなく**取り込んだデータの到達不能の解消**なので、
 * 判断基準は「PKC2 で見えていたものが、同じ順で見えるか」である。
 */
import { describe, expect, it } from 'vitest';
import { BROWSE_ICONS } from '../../src/adapter/ui/render/icons';
import {
  buildTiles,
  dualTile,
  BUILTIN_GROUP,
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
  SELFHOST_TILE_LID,
  SCHEDULE_TILE_LID,
  CONTACTS_TILE_LID,
  contactsTile,
  SEARCH_TILE_LID,
  searchTile,
  SQL_TILE_LID,
  CAPTURES_TILE_LID,
  capturesTile,
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
  /**
   * 🔴 **組み込みは名前の付いた群に入る**(#531 段② / #281。2026-09-08)。
   * ⚠ 直す前は 6 枚とも既定群(`''`)で、**user が入れたタイルと地続き**だった ──
   *   群にも分かれず目印も無いので、自分で入れたものが下へ押し下がって見えた。
   * 🔴 **末尾へ「収納」する**(user 指示 2026-08-28 の「収納して整理する」)──
   *   先頭のままだと 6 枚が上を占め、自分で入れたタイルが下へ押し下がって見える。
   *   ⚠ 名前を付けただけで先頭に残すと、並びが「名前つき → 名前なし → 名前つき」に
   *   なり、名前の無い群が 2 つの見出しに挟まれる(読めない)。
   * ⚠ **組み込みの中の順番は変えない**(2 ペイン → … → マニュアル)。
   */
  it('組み込みは 2 ペイン → 予定表 → 連絡先 → 探す → Office → マニュアルの順で、名前の付いた群として末尾に付く', () => {
    const merged = withBuiltinTiles(entryTiles, { office: true });
    // 🔴 **自分で入れたタイルが先**(#281 の実害を直した向き)
    expect(merged.slice(0, entryTiles.length), '自分のタイルが先頭に残っていない').toEqual(
      entryTiles,
    );
    const b = merged.slice(entryTiles.length);
    expect(b[0]).toEqual({
      lid: DUAL_TILE_LID,
      title: '2 ペインで整理',
      group: BUILTIN_GROUP,
      kind: 'dual',
      symbol: 'tools',
    });
    /**
     * ⚠ **カレンダー / やることの板は #292 段⑤ でここから外れた**(2026-08-23)──
     *   あの 2 つは「アプリ」ではなく**ノートの見方**だったので、左の列の
     *   「予定」タブへ引っ越した。
     * 🔴 **予定表は #673 段②(user 裁定 2026-09-04「アプリの基本は別窓」)で
     *   別窓の入口として戻った** ── 左のタブは残したまま、2 つ目の入口である。
     *   Office より前(アプリに最初から在るものを先に ── Office の有無で位置が動かない)。
     */
    expect(b[1]).toEqual({
      lid: SCHEDULE_TILE_LID,
      title: '予定表',
      group: BUILTIN_GROUP,
      kind: 'schedule',
      symbol: 'calendar',
    });
    // ⚠ 連絡先(#278 段③)は予定表の次 ── 同じく「アプリに最初から在る」側
    expect(b[2]).toEqual({
      lid: CONTACTS_TILE_LID,
      title: '連絡先',
      group: BUILTIN_GROUP,
      kind: 'contacts',
      symbol: 'person',
    });
    // ⚠ 探す(#680)は連絡先の次 ── 同じく「アプリに最初から在る」側(Office より前)
    expect(b[3]).toEqual({
      lid: SEARCH_TILE_LID,
      title: '探す',
      group: BUILTIN_GROUP,
      kind: 'search',
      symbol: 'search',
    });
    expect(b[4]).toEqual({
      lid: OFFICE_TILE_LID,
      title: 'Office',
      group: BUILTIN_GROUP,
      kind: 'office',
      symbol: 'page',
    });
    /**
     * 🔴 **マニュアルは最後**(#645、2026-08-31)── 2 ペインと Office は
     *   「作業する所」で、マニュアルは「読む所」である。読み物の有無で
     *   作業の口の位置を動かさない(上の「位置が動かない向きに並べる」と同じ判断)。
     */
    expect(b[5]).toEqual({
      lid: MANUAL_TILE_LID,
      title: 'マニュアル',
      group: BUILTIN_GROUP,
      kind: 'manual',
      symbol: 'book',
    });
    /**
     * 🔴 **自分のパソコンで動かす は最後**(#532 段 B、2026-09-09)。
     * ⚠ これは「作業する所」でも「読む所」でもなく、**1 度だけ使う支度**である ──
     *   最後に置けば、足しても他のタイルの位置が 1 つも動かない。
     */
    expect(b[6]).toEqual({
      lid: SELFHOST_TILE_LID,
      title: '自分のパソコンで動かす',
      group: BUILTIN_GROUP,
      kind: 'selfhost',
      symbol: 'computer',
    });
    /**
     * 🔴 **SQL の面も最後**(#681 段②、2026-09-09)── 支度の口と同じ理由で、
     *   足しても他のタイルの位置が 1 つも動かない。
     */
    expect(b[7]).toEqual({
      lid: SQL_TILE_LID,
      title: 'SQL で調べる',
      group: BUILTIN_GROUP,
      kind: 'sql',
      symbol: 'database',
    });
    // ⚠ 録ったもの(#683 段①)も末尾 ── SQL と同じ理由(位置を動かさない)
    expect(b[8]).toEqual({
      lid: CAPTURES_TILE_LID,
      title: '音/動画',
      group: BUILTIN_GROUP,
      kind: 'captures',
      symbol: 'mic',
    });
    // ⚠ entry 由来の並びには触らない(合流は**後置**だけ ── 2026-09-08 に前置から変えた)
    expect(b, '組み込みが 9 枚ちょうどでない').toHaveLength(9);
  });

  it('🔴 Office が入っていなくても、最初から在るものは出る(位置も動かない)', () => {
    const merged = withBuiltinTiles(entryTiles, { office: false });
    // ⚠ 組み込みは**末尾**(2026-09-08 に前置から変えた ── #531 段② / #281)
    const b = merged.slice(entryTiles.length);
    expect(b[0]?.lid, 'Office の有無で 2 ペインの位置が動いた').toBe(DUAL_TILE_LID);
    expect(b[1]?.lid, 'Office の有無で予定表の位置が動いた').toBe(SCHEDULE_TILE_LID);
    expect(b[2]?.lid, 'Office の有無で連絡先の位置が動いた').toBe(CONTACTS_TILE_LID);
    expect(b[3]?.lid, 'Office の有無で探すの位置が動いた').toBe(SEARCH_TILE_LID);
    expect(b[4]?.lid, 'Office の有無でマニュアルの位置が動いた').toBe(MANUAL_TILE_LID);
    expect(b[5]?.lid, 'Office の有無で支度の口の位置が動いた').toBe(SELFHOST_TILE_LID);
    expect(b[6]?.lid, 'Office の有無で SQL の面の位置が動いた').toBe(SQL_TILE_LID);
    expect(merged.slice(0, entryTiles.length)).toEqual(entryTiles);
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
      'selfhost',
      'sql',
      // ⚠ 録ったもの(#683 段①)── 末尾(足しても他の位置が動かない)
      'captures',
    ]);
    // ⚠ Office を入れていない端末でも、面は空にならない
    expect(withBuiltinTiles([], { office: false }).map((t) => t.kind)).toEqual([
      'dual',
      'schedule',
      'contacts',
      'search',
      'manual',
      'selfhost',
      'sql',
      'captures',
    ]);
  });

  /**
   * 🔴 **組み込みタイルの目印**(#281。user 裁定 2026-09-12)。
   *
   * ⚠ 直す前は **9 枚とも空**で、自分で登録したアプリだけ絵が付いていた。
   * 🔑 見るのは 3 つ:**①全部が持っている ②どれが何か ③左のタブと同じ絵か**。
   *   ⚠ ①だけだと「9 枚とも同じ絵」で素通りし、②だけだと**次に足した 1 枚が
   *   空のまま**でも緑になる(この repo の作法は「新しいタイルは末尾へ足す」)。
   */
  it('🔴 組み込みタイルは 1 枚残らず目印を持つ', () => {
    const merged = withBuiltinTiles([], { office: true });
    const missing = merged.filter((t) => t.symbol === undefined).map((t) => t.title);
    expect(missing, `目印の無い組み込みタイル: ${missing.join(' / ')}`).toEqual([]);
    // ⚠ **空振り防止** ── 組み込みが 1 枚も無ければ上は常に真
    expect(merged.length).toBeGreaterThanOrEqual(9);
    // ⚠ 打った字の目印(`icon`)とは**同時に立たない**
    expect(merged.filter((t) => t.icon !== undefined)).toEqual([]);
  });

  it('🔴 どの絵を割り当てたか(user 裁定 2026-09-12)', () => {
    const merged = withBuiltinTiles([], { office: true });
    expect(new Map(merged.map((t) => [t.kind, t.symbol]))).toEqual(
      new Map([
        ['dual', 'tools'],
        ['schedule', 'calendar'],
        ['contacts', 'person'],
        ['search', 'search'],
        // 🔑 user 裁定で「仕事」ではなく**「文書」**になった
        ['office', 'page'],
        ['manual', 'book'],
        ['selfhost', 'computer'],
        ['sql', 'database'],
        ['captures', 'mic'],
      ]),
    );
  });

  /**
   * 🔴 **左の列に同じ面が在るものは、`BROWSE_ICONS` と同じ名前を使う**(#281)。
   *
   * ⚠ **これは「画面で揃って見える」ことの検査ではない** ── 左のタブの図案は
   *   `app.css` で `display: none` にしてあり、いま画面には 1 つも出ていない
   *   (2026-08-27、タブが 5 枚を超えて 2 段になったため)。
   * 🔑 それでも縛るのは、**図案を戻した日にずれない**ためである
   *   (その規則の注記が「印は消さずに残す」と言っているのと同じ向き)。
   * ⚠ そして **`folder` を使っていない**ことも見る ── **一覧の行のフォルダのノート**が
   *   既にその絵を色付きで使っているので、2 ペインに使うと**同じ絵が 2 つの違うものを指す**。
   */
  it('🔴 左のタブと同じ面のタイルは、同じ図案の名前を使う', () => {
    const merged = withBuiltinTiles([], { office: true });
    /**
     * 🔑 **対になる組み込みは導出する**(2026-09-12、着地前レビュー ⚠3)。
     * ⚠ 直す前は `['schedule','contacts','captures']` と**手書き**で、
     *   同じ 3 件が `tiles.ts` の注記・マニュアル・ここの 3 か所に散っていた ──
     *   **4 組目を足した日に、この loop だけ 3 件のまま**で誰も見ない。
     * ⚠ この repo の作法は「新しいタイルは末尾へ足す」なので、穴は
     *   **いちばん足しやすい場所**に開いていた。
     */
    const mirrored = merged.filter((t) => Object.hasOwn(BROWSE_ICONS, t.kind));
    expect(
      mirrored.map((t) => t.kind),
      '左のタブと対になる組み込みが増減した ── `tiles.ts` の注記とマニュアルも直す',
    ).toEqual(['schedule', 'contacts', 'captures']);
    for (const t of mirrored) {
      const tab = BROWSE_ICONS[t.kind];
      /**
       * ⚠ **空振り防止はここ**(着地前レビュー ⚠2)── 直す前は loop の**後ろ**に
       *   「表が空でないこと」を置いていたが、タイル側の `symbol` は直書きなので
       *   **loop が先に落ち、その行は一度も評価されない**。しかも落ちたときの文言が
       *   「タイルの絵が違う」と読めて、**崩れているのは前提(表)**だと分からない。
       */
      expect(tab, `左のタブ(${t.kind})の図案が表に無い ── 前提が崩れている`).toBeDefined();
      expect(t.symbol, `${t.kind} の図案の名前が ${String(tab)} でない`).toBe(tab);
    }
    /**
     * ⚠ **前提を先に検める**(着地前レビュー 変異 C)── `filer` の鍵が改名されると
     *   `BROWSE_ICONS['filer']` は `undefined` になり、`not.toContain(undefined)` は
     *   **常に真**になって無言化する。
     */
    const filerIcon = BROWSE_ICONS['filer'];
    expect(filerIcon, 'フォルダのタブの図案が引けない ── 前提が崩れている').toBeDefined();
    expect(merged.map((t) => t.symbol)).not.toContain(filerIcon);
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
    expect(tileSelectsEntry(capturesTile()), '録ったもので選択が立つ').toBe(false);
    expect(tileSelectsEntry(officeTile())).toBe(false);
    expect(tileSelectsEntry(entryTiles[0]!), 'entry 由来まで立たなくなった').toBe(true);
  });

  it('tileSelectsEntry ── 組み込みだけ選択を立てない', () => {
    expect(tileSelectsEntry(officeTile())).toBe(false);
    for (const t of entryTiles) expect(tileSelectsEntry(t)).toBe(true);
  });
});

/**
 * 🔴 **目印(`attachment.app_icon`)の門**(#770 段②、2026-09-12)。
 *
 * ⚠ ここには **`icon` の検査が 1 件も無かった**(実測)。目印は
 *   `[...iconRaw].slice(0, 2).join('')` と書いてあり、
 *   **2 字に切る**判断も **サロゲートペアを割らない**判断も、
 *   **外しても全 test が緑**の状態で置かれていた。
 * 🔑 段② はこの行を必ず通る(名前を打つと `ca` と出るのを直す)ので、
 *   触る前に**いまの振る舞いを字で留める**。
 */
describe('タイルの目印', () => {
  const iconOf = (icon: string): string | undefined =>
    tileFrom({
      lid: 'i',
      title: 'アプリ',
      body: body({
        'attachment.registered_as_app': true,
        'attachment.asset_key': 'k',
        'attachment.mime': 'text/html',
        'attachment.app_icon': icon,
      }),
    })?.icon;

  it('🔴 長い字は 2 字までに切る(行の高さを崩させない)', () => {
    // ⚠ 切る処理を外すと 'abcd' がそのまま入る = この行が落ちる
    expect(iconOf('abcd')).toBe('ab');
  });

  it('🔴 絵文字を割らない(`slice` ではなく符号位置で数える)', () => {
    // ⚠ `iconRaw.slice(0, 2)` に退化すると、🧮(2 符号単位)が**半分**で切れて
    //    文字化けする ── 「2 字」の数え方が字ではなく符号単位になる
    expect(iconOf('🧮a')).toBe('🧮a');
    expect(iconOf('🧮📅🖩')).toBe('🧮📅');
  });

  /**
   * 🔴 **図案の名前を書くと、絵になる**(#770 段②)。
   *
   * ⚠ 直す前は `calendar` と打つと **`ca`** と出ていた(上の「2 字に切る」に当たる)──
   *   豆腐でも無反応でもなく、**それらしく壊れる**いちばん読みにくい形だった。
   */
  const symbolOf = (icon: string): string | undefined =>
    tileFrom({
      lid: 'i',
      title: 'アプリ',
      body: body({
        'attachment.registered_as_app': true,
        'attachment.asset_key': 'k',
        'attachment.mime': 'text/html',
        'attachment.app_icon': icon,
      }),
    })?.symbol;

  it('🔴 図案の名前を丸ごと書くと、絵で置く(`ca` と出さない)', () => {
    expect(symbolOf('calendar')).toBe('calendar');
    // ⚠ **字のほうは立てない** ── 2 つ立つと、出す側が「どちらを描くか」を持つ
    expect(iconOf('calendar'), '字と絵が両方立っている').toBeUndefined();
  });

  it('🔴 いま絵文字を書いている人は 1 ドットも変わらない', () => {
    expect(iconOf('🧮')).toBe('🧮');
    expect(symbolOf('🧮')).toBeUndefined();
  });

  it('🔴 丸ごと一致だけ ── 途中まで同じ字は化けない', () => {
    // ⚠ 前方一致で拾うと、`ca` と打った人の字が予定表の絵になる
    expect(symbolOf('ca')).toBeUndefined();
    expect(iconOf('ca')).toBe('ca');
    // ⚠ 後ろに伸びた名前も別物(CLAUDE.md §1「頭と尻を両方留める」)
    expect(symbolOf('calendarx')).toBeUndefined();
    expect(iconOf('calendarx')).toBe('ca');
  });

  it('前後の空白は落として見る(frontmatter に空白が残っていても絵になる)', () => {
    /**
     * ⚠ **引用符つきで書く**(2026-09-12、着地前レビュー C)。
     * 🔑 引用符なしの値は `parseFrontmatter` が**既に落としている**ので、
     *   `'  calendar  '` では `trim()` を外しても緑 ── この道を 1 度も通らない
     *   (CLAUDE.md §2「経路が一度も通っていない」)。
     * ⚠ 引用符つきなら空白は**値の一部として残る**(実測)ので、ここで初めて
     *   `trim()` が効いているかを見られる。
     */
    expect(symbolOf('"  calendar  "')).toBe('calendar');
    expect(symbolOf("'  calendar  '")).toBe('calendar');
  });

  /**
   * 🔴 **表に無い名前が「在る」ことにならない**(原型の鍵)。
   * ⚠ `raw in PKC_SYMBOLS` や `PKC_SYMBOLS[raw] !== undefined` で書くと、
   *   `constructor` / `toString` が**真になる** ── そのとき `data-pkc-symbol` に
   *   その字が入り、CSS に規則が無いので**何も出ない**(無言で消える)。
   */
  it('🔴 `constructor` のような原型の鍵は図案にしない', () => {
    for (const bad of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(symbolOf(bad), `${bad} が図案として通った`).toBeUndefined();
    }
  });

  it('目印が無いときは持たない(既定の絵を勝手に置かない)', () => {
    expect(iconOf('')).toBeUndefined();
    expect(
      tileFrom({
        lid: 'j',
        title: 'アプリ',
        body: body({
          'attachment.registered_as_app': true,
          'attachment.asset_key': 'k',
          'attachment.mime': 'text/html',
        }),
      })?.icon,
    ).toBeUndefined();
  });
});
