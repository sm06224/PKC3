import { createHash } from 'node:crypto';
/**
 * 🔴 **右クリックに出す操作が、押して動くこと**(#426 段①)。
 *
 * ## なぜ専用の検査が要るか
 *
 * `repo-hygiene` に「**受け手のいない `data-pkc-action` が無い**」という
 * 全数検査が既に在る。⚠ **だがそれはこのメニューを見ていない** ──
 * あちらが拾うのは
 * `setAttribute('data-pkc-action', 'export-entry')` という**字で書かれた形**で、
 * 右クリックのメニューは `setAttribute('data-pkc-action', it.action)` と
 * **変数で渡す**からである。
 *
 * 🔴 つまり `ENTRY_MENU_ACTIONS` に綴り違いを 1 つ入れると、
 * **メニューには出るのに押しても無言**になり、**既存の検査は 1 つも鳴らない**。
 * ⚠ これは #98 / #100 で 4 面ぶん潰した「無言の dead click」を**新設する**形である。
 *
 * 🔑 だから**表の側から**受け手を突き合わせる。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  APP_GROUP_MENU_ACTIONS,
  appGroupMenuActions,
  tableConvertPickLabel,
  tableMenuActions,
  ADOPT_IMAGES_LABEL,
  adoptImagesLabel,
  BODY_MENU_ACTIONS,
  bodyMenuActions,
  ENTRY_ACTION_HINTS,
  ENTRY_ACTION_HINT_MAX,
  menuShortcutFor,
  ENTRY_ACTION_LABELS,
  ENTRY_MENU_ACTIONS,
  entryActionHint,
  entryMenuActions,
  TILE_MENU_ACTIONS,
  tileMenuActions,
  TASK_REPEAT_MENU_ACTION,
  repeatMenuActions,
  REPEAT_ATTR,
  entryActionWidthTier,
} from '../../src/features/entry-actions';

/** `binder.ts` の受け手の表を読む。⚠ 集め方は `repo-hygiene` と**同じ形**にする。 */
function handlers(): ReadonlySet<string> {
  const binder = readFileSync('src/adapter/ui/actions/binder.ts', 'utf-8');
  const at = binder.indexOf('const ACTIONS: Record<string, ActionHandler> = {');
  expect(at, '前提: 受け手の表を見つけられていない').toBeGreaterThan(0);
  return new Set([...binder.slice(at).matchAll(/^\s{2}'([a-z0-9-]+)':/gm)].map((m) => m[1]!));
}

describe('右クリックに出す操作', () => {
  it('🔴 どれにも受け手がある(押して無言にならない)', () => {
    const have = handlers();
    // ⚠ 空振り防止 ── 表を読めていないのに「全部在る」を作らない
    expect(have.size, '受け手の表を読めていない(空振り)').toBeGreaterThan(20);
    expect(ENTRY_MENU_ACTIONS.length, 'メニューが空(空振り)').toBeGreaterThanOrEqual(3);

    /**
     * ⚠ **右クリックに出す表を、1 つ残らず当てる**(2026-09-12、#857 段① の
     *   着地前レビュー)── 1 稿目は `ENTRY_MENU_ACTIONS` だけを見ており、
     *   あとから足した `TILE_MENU_ACTIONS`(アプリのタイルの「上へ / 下へ」)は
     *   **綴りを 1 つ壊しても全部緑**だった(メニューには出るのに押すと無言)。
     * 🔑 表が増えたらここへ足す ── `data-pkc-action` を**変数で渡す**メニューは、
     *   `repo-hygiene` の字面の走査に 1 件も当たらない(この file の冒頭の戒め)。
     */
    const dead = [
      ...ENTRY_MENU_ACTIONS,
      ...TILE_MENU_ACTIONS,
      // ⚠ 2026-09-13(#857 段①b-2): モードの出入りも同じ表から出る
      // ⚠ 2026-09-13(#884 段②): その 1 回だけの開き方も同じ表から出る
      ...tileMenuActions(false, 'tab'),
      ...tileMenuActions(true, 'window'),
      // ⚠ 2026-09-13(#855 段 0): 札の「繰り返す…」と、その 2 段目
      TASK_REPEAT_MENU_ACTION,
      ...repeatMenuActions(null),
      ...repeatMenuActions('week'),
      /**
       * ⚠ 2026-09-13(#857 段②): グループの見出しのメニュー。
       * 🔴 **足した日にここへ入れ忘れていた** ── 調査が拾った。入れるまでは
       *   「メニューには出るのに押しても無言」を**この門が 1 件も見ていなかった**
       *   (すぐ上の 2026-09-12 の戒めと、まったく同じ抜け方である)。
       */
      ...APP_GROUP_MENU_ACTIONS,
      /**
       * ⚠ 2026-09-13(#857 段③): 「名前順に戻す」は**組み立てる関数の側**に在る
       *   (番号が付いているときだけ出す)ので、素の表を並べただけでは**漏れる**。
       * 🔑 だから **`appGroupMenuActions` を両方の答えで**呼ぶ ── 出る側も出ない側も
       *   数え上げる(引数で消える行を、この門から消さない)。
       */
      ...appGroupMenuActions(false),
      ...appGroupMenuActions(true),
    ]
      .filter((a) => !have.has(a.action))
      .map((a) => a.action);
    expect(dead, '受け手のいない操作をメニューに出している(押しても無言)').toEqual([]);
    // ⚠ 空振り防止 ── 足した表が空なら、上の走査は増えていないのと同じ
    expect(TILE_MENU_ACTIONS.length, 'タイルのメニューが空(空振り)').toBeGreaterThanOrEqual(2);
    expect(repeatMenuActions(null).length, '刻みの一覧が空(空振り)').toBe(4);
    expect(
      APP_GROUP_MENU_ACTIONS.length,
      'グループの見出しのメニューが空(空振り)',
    ).toBeGreaterThanOrEqual(1);
    /**
     * ⚠ **引数で行が増えることを pin する** ── 増えないなら、上の 2 回呼びは
     *   同じ物を 2 度数えているだけで、**何も守っていない**。
     */
    expect(
      appGroupMenuActions(true).length - appGroupMenuActions(false).length,
      '番号が在るときの行が増えていない(2 回呼ぶ意味が無い)',
    ).toBe(1);
  });

  it('⚠ 空振り防止 ── 綴りを 1 つ壊せば、この検査は落ちる', () => {
    const have = handlers();
    // 🔑 「全部在る」が**在りえない綴りでも真になる**形でないことを確かめる
    expect(have.has('export-entry-typo-xxx'), '前提: 在りえない綴りが受け手に在る').toBe(false);
  });

  it('🔴 字は 1 か所から来る(情報ペインと食い違わない)', () => {
    /**
     * ⚠ 情報ペインが**自前の字**へ戻ると、同じ操作が面によって別の名前で出る。
     * 🔑 だから「情報ペインが表を引いていること」を字面で pin する ──
     *   ⚠ 弱い検査だと自覚して使う(原文 pin なので、呼び方を変えれば外れる)。
     */
    const inspector = readFileSync('src/adapter/ui/render/inspector.ts', 'utf-8');
    /**
     * 🔴 **引き方は 2 通りある**(#1029 段 C で `entryBtn()` に寄せた)。
     * ⚠ 直す前はこの検査が `ENTRY_ACTION_LABELS['<綴り>']` という**字面 1 通り**しか
     *   受けなかったので、**表から引く形に寄せた瞬間に落ちる** ── 落ちる理由は
     *   「自前の字へ戻った」ではなく「引き方が変わった」であり、**主張が的を外す**。
     * 🔑 だから**表から引いていること**を、2 つの形のどちらかで認める:
     *   ① `ENTRY_ACTION_LABELS['<綴り>']`(1 件ずつ引く昔の形)
     *   ② `entryBtn('<綴り>')`(綴りだけ渡し、字は中で表から引く いまの形)
     */
    for (const a of ENTRY_MENU_ACTIONS) {
      const fromTable =
        inspector.includes(`ENTRY_ACTION_LABELS['${a.action}']`) ||
        inspector.includes(`entryBtn('${a.action}')`);
      expect(
        fromTable,
        `情報ペインが「${a.label}」の字を自前で持っている(表から引いていない)`,
      ).toBe(true);
      // ⚠ 直書きが**戻っていない**ことも見る(引きつつ横に直書きを残せてしまう)
      expect(
        inspector.includes(`btn('${a.action}', '${a.label}')`),
        `情報ペインに「${a.label}」の直書きが残っている`,
      ).toBe(false);
    }
    // ⚠ 空振り防止 ── ②の形が 1 件も無いなら、上の `||` は昔の形しか見ていない
    expect(
      inspector.includes("entryBtn('copy-entry-ref')"),
      '前提: いまの引き方(entryBtn)が 1 件も無い',
    ).toBe(true);
  });

  it('⚠ 綴りと字の対応が崩れていない', () => {
    for (const a of ENTRY_MENU_ACTIONS) expect(ENTRY_ACTION_LABELS[a.action]).toBe(a.label);
    expect(Object.keys(ENTRY_ACTION_LABELS)).toHaveLength(ENTRY_MENU_ACTIONS.length);
  });
});

/**
 * 🔴 **右ペインが唯一の入口だった 3 つに、2 本目の道を作る**(#500、2026-08-29)。
 *
 * ⚠ 実測(既定の窓 1280×720・実ブラウザ):
 *
 *   | ノート | スクロールしないと見えない量 | PDF は押せるか |
 *   |---|---|---|
 *   | 空に近い(既存 smoke の fixture) | 0px | ✅ |
 *   | 見出し 10 | 100px | 🔴 押せない |
 *   | 見出し 20 + タグ | 360px | 🔴 押せない |
 *
 *   境目は**見出し 5〜10 の間**。さらに右ペインは畳めるので、
 *   畳んだ user からは**画面ごと消える**。
 */
describe('右ペインが唯一の入口だった 3 つ(#500)', () => {
  it('🔴 Word / PowerPoint / PDF が右クリックにも出る', () => {
    const have = new Set(ENTRY_MENU_ACTIONS.map((a) => a.action));
    for (const a of ['export-entry-docx', 'export-entry-pptx', 'export-entry-pdf']) {
      expect(have.has(a), `${a} が右クリックに無い(右ペインを畳むと届かない)`).toBe(true);
    }
  });

  it('⚠ 消す物はいちばん下のまま(勢いで削除に当たらない)', () => {
    const last = ENTRY_MENU_ACTIONS[ENTRY_MENU_ACTIONS.length - 1];
    expect(last?.action, '削除が最後ではない').toBe('delete-entry');
  });

  it('🔑 渡す物の隣に置く(履歴と削除より上)', () => {
    const at = (a: string): number => ENTRY_MENU_ACTIONS.findIndex((x) => x.action === a);
    for (const a of ['export-entry-docx', 'export-entry-pptx', 'export-entry-pdf']) {
      expect(at(a), `${a} が履歴より下に居る`).toBeLessThan(at('show-history'));
    }
  });
});

/**
 * 🔴 **右ペインが唯一の入口だった、残りの 3 つ**(#500 案 C、2026-08-29)。
 *
 * 上の 3 つ(Word / PowerPoint / PDF)は**いつでも押せる**ので表へ足すだけで済んだ。
 * ⚠ 残る 3 つは**条件つき**である ── フォルダのときだけ / 元ファイルが在るときだけ /
 *   外部の画像が在るときだけ。だから「常に出して、押したら失敗する」形にはできない
 *   (#399 ① で確かめてある:ノートで `フォルダを書き出す` を押すと必ず失敗する)。
 *
 * 🔑 **門を 2 つ置いたので、2 つ目だけが鳴る場面を 2 通り作る**
 *   (CLAUDE.md §1、2026-08-24 の #225 で変異試験 2 件が SURVIVED した型)──
 *   両方を同時に満たす fixture 1 本だと、**片方の門を殺しても、もう片方が救って
 *   落ち続ける**。
 */
describe('条件つきの操作(#500 案 C)', () => {
  const NOTE = { archetype: 'text', linkedFile: null };
  const acts = (ctx: { archetype: string | null; linkedFile: string | null }): string[] =>
    entryMenuActions(ctx).map((a) => a.action);

  it('🔴 フォルダのときだけ「フォルダを書き出す」が出る', () => {
    // ⚠ **元ファイルは無い**まま見る ── linked の門に救われない場面
    expect(acts({ archetype: 'folder', linkedFile: null })).toContain('export-folder');
    expect(acts(NOTE), 'ふつうのノートで出ている(押すと必ず失敗する)').not.toContain(
      'export-folder',
    );
    // ⚠ 種類が分からないときは**出さない側**へ倒す
    expect(acts({ archetype: null, linkedFile: null })).not.toContain('export-folder');
  });

  it('🔴 元ファイルを開いているときだけ「書き戻す」が出る', () => {
    // ⚠ **フォルダではない**まま見る ── folder の門に救われない場面
    expect(acts({ archetype: 'text', linkedFile: 'memo.md' })).toContain('write-back-file');
    expect(acts(NOTE), '開いていないのに上書きの口を出している').not.toContain('write-back-file');
  });

  it('⚠ 条件つきの物を外しても、並びは動かない(削除はいつでも最後)', () => {
    for (const ctx of [
      NOTE,
      { archetype: 'folder', linkedFile: null },
      { archetype: 'text', linkedFile: 'memo.md' },
      { archetype: 'folder', linkedFile: 'memo.md' },
    ]) {
      const a = acts(ctx);
      expect(a[a.length - 1], `${JSON.stringify(ctx)} で削除が最後ではない`).toBe('delete-entry');
      // ⚠ 空振り防止 ── 条件つきを外しても、常設の物は全部残っている
      expect(a).toContain('export-entry');
      expect(a).toContain('show-history');
    }
  });

  it('🔑 「書き戻す」は書き出しの群れの外(履歴のすぐ上)に居る', () => {
    /**
     * ⚠ これは**上書き**であって、新しい file を作る隣の 5 つとは別の物である。
     *   混ぜて置くと、渡すつもりで押した人が**元ファイルを潰す**。
     */
    const a = acts({ archetype: 'text', linkedFile: 'memo.md' });
    expect(a.indexOf('write-back-file')).toBeGreaterThan(a.indexOf('export-entry-pdf'));
    expect(a.indexOf('write-back-file')).toBeLessThan(a.indexOf('show-history'));
  });

  it('🔴 外部の画像が在るときだけ、本文のメニューに取り込みが出る', () => {
    const zero = bodyMenuActions({ externalImages: 0 }).map((a) => a.action);
    expect(zero, '0 枚なのに出ている(押しても何も起きない)').not.toContain(
      'adopt-external-images',
    );
    // ⚠ 空振り防止 ── 0 枚でも本来の 2 つは出ている
    expect(zero.length, '本文のメニューが空(空振り)').toBeGreaterThanOrEqual(2);

    const three = bodyMenuActions({ externalImages: 3 });
    const found = three.find((a) => a.action === 'adopt-external-images');
    expect(found, '3 枚あるのに出ていない').toBeDefined();
    // 🔴 **枚数を字に出す** ── 押すとその数だけ外へ通信するので、押す前に規模を見せる
    expect(found?.label).toBe('外部の画像を取り込む(3 枚)');
    // ⚠ 足すのは**末尾** ── 既に在る 2 つの位置を動かさない
    expect(three.map((a) => a.action).slice(0, zero.length)).toEqual(zero);
  });

  it('⚠ 字は表から来る(情報ペインと食い違わない)', () => {
    // 🔑 上の「字は 1 か所から来る」検査が条件つきの 2 行も見るようになっている
    expect(ENTRY_ACTION_LABELS['export-folder']).toBe('このフォルダをバックアップ');
    expect(ENTRY_ACTION_LABELS['write-back-file']).toBe('元ファイルへ書き戻す');
    // ⚠ 取り込みは枚数を含むので表ではなく組み立て関数が持つ
    expect(adoptImagesLabel(1)).toContain(ADOPT_IMAGES_LABEL);
  });
});

/**
 * 🔴 **右クリックの項目も説明を持つ**(#587 改善 C-1)。
 *
 * ⚠ 直す前は**情報ペインの 11 個だけ**が説明を持ち、**右クリックの 9 個は 9 個とも空**
 *   だった(実測 2026-08-29)。同じ字・同じ操作なのに、片方だけ黙っていた。
 * 🔑 しかも右クリックは「右の列を畳んだ人のための 2 本目の道」(マニュアル「画面を組み替える」)なので、
 *   **説明が要るのはむしろこちら**である。
 *
 * ⚠ **「鍵が在るか」だけを見ない**(§1)── 値が空文字でも鍵は在る。
 *   ここは**配られた側**(`entryMenuActions` の返り値)で、**中身が空でない**ことを見る。
 */
describe('見出し・本文のメニューの近道(#587 C 案 2)', () => {
  /** 割当の台帳の代わり ── 段組みだけ割当を持つ。 */
  const chord = (id: string): string | null => (id === 'cycle-read-columns' ? 'Alt + C' : null);

  it('🔴 修飾キー + クリックは、mac では ⌘ / ⌥ の綴りになる', () => {
    expect(menuShortcutFor('edit-from-heading', { mac: false, chord })).toBe('Ctrl + クリック');
    expect(menuShortcutFor('edit-from-heading', { mac: true, chord })).toBe('⌘ + クリック');
    expect(menuShortcutFor('append-at-heading', { mac: false, chord })).toBe('Alt + クリック');
    expect(menuShortcutFor('append-at-heading', { mac: true, chord })).toBe('⌥ + クリック');
  });

  it('鍵の割当がある項目はその字、無い項目は空(呼び側が属性を付けない)', () => {
    expect(menuShortcutFor('cycle-read-columns', { mac: false, chord })).toBe('Alt + C');
    expect(menuShortcutFor('pin-split', { mac: false, chord })).toBe('');
    expect(menuShortcutFor('toggle-heading-fold', { mac: true, chord })).toBe('');
  });
});

describe('右クリックの説明(#587 C-1)', () => {
  /**
   * 🔴 **説明は 2 行に収める**(#587 C-3)。メニューの下の欄は 2 行固定なので、
   *   超えた分は**切れて読めない**(欄の幅 22rem = 全角 28 字 × 2 行 = 56 字)。
   * ⚠ 上限は `ENTRY_ACTION_HINT_MAX` 1 か所(CSS の幅と対で読む)。
   */
  it('🔴 説明はどれも 2 行に収まる長さ(ENTRY_ACTION_HINT_MAX 以下)', () => {
    const over = Object.entries(ENTRY_ACTION_HINTS)
      .filter(([, h]) => h.length > ENTRY_ACTION_HINT_MAX)
      .map(([k, h]) => `${k}: ${h.length} 字`);
    expect(Object.keys(ENTRY_ACTION_HINTS).length, '表が空(空振り)').toBeGreaterThan(5);
    expect(over, '欄からはみ出す説明がある').toEqual([]);
    // ⚠ 上限そのものが緩んでいない(3 行分にすると CSS の 2 行固定で切れる)
    expect(ENTRY_ACTION_HINT_MAX).toBe(56);
  });

  /**
   * 🔴 **説明を取り違えても、いままで誰も鳴らなかった**(#587 C-3 の着地後レビュー)。
   *
   * ⚠ 上の上限の検査は**字数しか見ていない**。中身を見ている 2 か所も
   *   **両辺が同じ表を読む同語反復**である(下の「すり替えない」/ `inspector-titles`)──
   *   だから `copy-entry-ref` と `copy-plain-markdown` の説明を**入れ替えても全部緑**
   *   だった。⚠ 実装のコメント自身が「字が同じ `copy-` が 2 つ並ぶので**書き分けないと
   *   選べない**」と言っている当の 2 件である。
   *
   * 🔑 作法はお知らせの `KNOWN` 表と同じ ── **綴り → 説明の digest の等値表**を置く。
   *   直したらここを書き換えないと落ちるので、**忘れられない**。
   * ⚠ 「変えるな」ではない ── 変えてよい。**変えたことが記録に残る**のが目的である。
   */
  it('🔴 どの綴りにどの説明が付いているか(取り違えを殺す等値表)', () => {
    const KNOWN: readonly [string, string][] = [
      // 🔴 付箋(#685 段②、2026-09-04)
      ['open-note-window', 'a3a6b9d4'],
      // 🔴 2026-09-21(#1017 段④b): バックアップ(このノート/このフォルダ)に改名・
      //    file 名の末尾を .pkc3-notes.zip に
      ['export-entry', 'cf003ab6'],
      ['export-entry-html', '7f0a31b1'],
      ['export-folder', 'b603d0ed'],
      ['export-entry-docx', 'e79a6f86'],
      ['export-entry-pptx', '60bcb9ea'],
      ['export-entry-pdf', 'c9838f51'],
      ['adopt-external-images', '36c7974a'],
      ['copy-entry-ref', '2614a326'],
      ['copy-plain-markdown', '73e9b322'],
      // 🔴 スタックに載せる(#633 段①、2026-09-05)── 帯の名前と押す字を同じ語にし、説明を持たせた
      ['pin-split', '1621a667'],
      // 🔴 保存したスタックを載せる(#633 段③)
      ['stack-load', 'd23f50ac'],
      ['show-history', '2511b05b'],
      ['delete-entry', '661f5844'],
      // 🔴 **左の列の道具 4 つ**(#632 段①)── 本文ページの ⋯ から押せるようにした
      [// ⚠ 2026-09-02: 一度「独立した添付のノートになります」へ下げたが、user 裁定
    //    (#666「読んでいたノートの本文に入る」)で**実装が字に追いついた**ので戻した
    'attach-file', 'a6636dfe'],
      ['start-audio-capture', '6313fe2e'],
      ['start-screen-capture', 'ec055655'],
      ['start-timer', '97214aee'],
      // 🔴 **表の形を変える 2 つ**(#708 段②、2026-09-05)
      ['table-to-csv', '2658a59b'],
      ['table-to-markdown', '70082c4c'],
      // 🔴 **左の列の行からの整理 3 つ**(#215、2026-09-05)
      ['rename-entry-begin', 'c951ee45'],
      ['move-to-folder', '4f9ac271'],
      ['create-in-folder', '80e07ad8'],
    ];
    const digest = (h: string): string =>
      createHash('sha256').update(h).digest('hex').slice(0, 8);
    // ⚠ 空振り防止 ── 表と実装の件数が食い違ったまま「全部一致した」と言わない
    expect(KNOWN.length, '表と実装の件数が違う(足したなら表にも 1 行足す)').toBe(
      Object.keys(ENTRY_ACTION_HINTS).length,
    );
    const map = new Map(KNOWN);
    const drift: string[] = [];
    for (const [action, hint] of Object.entries(ENTRY_ACTION_HINTS)) {
      const want = map.get(action);
      if (want === undefined) {
        drift.push(`${action}: 表に無い(足したなら ['${action}', '${digest(hint)}'] を足す)`);
        continue;
      }
      if (want !== digest(hint))
        drift.push(`${action}: 説明が変わっている(${want} → ${digest(hint)})`);
    }
    expect(drift, '説明の取り違え / 書き換えが記録に残っていない').toEqual([]);
  });

  /**
   * ⚠ 条件つきの物も出る文脈 ── これを使わないと条件つきの行が**一度も検められない**。
   * ⚠ 2026-09-05(#633 段③): 種類の条件が 2 つ(フォルダ / スタック)になり、1 つの文脈では
   *   全部を出せない ── **2 つの文脈の和**で全数を見る。
   */
  const ALL = { archetype: 'folder', linkedFile: 'メモ.md' } as const;
  const ALL_STACK = { archetype: 'stack', linkedFile: 'メモ.md' } as const;

  it('🔴 出る項目は 1 つ残らず説明を持つ(足した人がここで気づく)', () => {
    const rows = [...entryMenuActions(ALL), ...entryMenuActions(ALL_STACK)];
    const seen = new Set(rows.map((a) => a.action));
    // ⚠ 空振り防止 ── 条件つきの行を含めて全部出ている
    expect([...seen].sort(), '条件つきの行が出ていない(台の前提が崩れている)').toEqual(
      ENTRY_MENU_ACTIONS.map((a) => a.action).sort(),
    );
    const silent = rows.filter((a) => a.hint === '').map((a) => a.action);
    expect(silent, '説明が空のまま配られている項目がある').toEqual([]);
  });

  /**
   * 🔴 **その場で組む 1 件も、上限の門の中に入れる**(#587 C-3 の着地後レビュー)。
   *
   * ⚠ `write-back-file` の説明は表に無く**その場で組む**ので、上の全数の上限検査に
   *   一度も当たっていなかった。⚠ 固定部分が 28 字なので、**名前が 28 字を超えると
   *   3 行目**に落ちて切れる ── 切れるのは末尾、つまり「**上書きします**」という、
   *   取り消せない操作だと言っている当の部分である。
   */
  it('🔴 長いファイル名でも「上書きします」まで読める(その場で組む 1 件の上限)', () => {
    const long = '2026年度第3四半期営業報告書_改訂版_確定_最終版.docx';
    // ⚠ 前提: この名前は縮めなければ上限を超える(超えないなら何も検めていない)
    expect(
      `元のファイル(${long})を上書きします。元の内容は戻せません(押すと確かめの窓が出ます)`.length,
      '前提が崩れている: この名前では上限を超えない',
    ).toBeGreaterThan(ENTRY_ACTION_HINT_MAX);
    const h = entryActionHint('write-back-file', { archetype: 'text', linkedFile: long });
    expect(h.length, '2 行に収まらない').toBeLessThanOrEqual(ENTRY_ACTION_HINT_MAX);
    expect(h, '上書きだと言う所が切れている').toContain('上書きします');
    // 🔴 #587 C 案 1 ── 取り消せないことと、確かめの窓が挟まることを言う(切れずに残る)
    expect(h, '取り消せないことを言っていない').toContain('元の内容は戻せません');
    expect(h, '確かめの窓が出ることを言っていない').toContain('(押すと確かめの窓が出ます)');
    // 🔑 頭と尻の両方を残す ── 頭だけだと拡張子が消え、尻だけだとどの文書か分からない
    expect(h, 'どの文書か分からない').toContain('2026年度');
    expect(h, '拡張子が消えている').toContain('.docx');
    // ⚠ **対照群** ── 短い名前は 1 字も縮めない
    expect(
      entryActionHint('write-back-file', { archetype: 'text', linkedFile: 'メモ.md' }),
      '短い名前まで縮めている',
    ).toBe('元のファイル(メモ.md)を上書きします。元の内容は戻せません(押すと確かめの窓が出ます)');
  });

  it('🔴 「書き戻す」だけは行き先を字に含める(押す前に確かめられる)', () => {
    const back = entryMenuActions(ALL).find((a) => a.action === 'write-back-file');
    expect(back?.hint, '上書き先のファイル名が説明に出ていない').toContain('メモ.md');
    // ⚠ **対照群** ── 静的な物は文脈で変わらない(何でも差し込む作りではない)
    const hist = entryMenuActions(ALL).find((a) => a.action === 'show-history');
    expect(hist?.hint).toBe(ENTRY_ACTION_HINTS['show-history']);
  });

  /**
   * ⚠ **これは「情報ペインと一致する」を見ていない**(着地前レビュー 🔴2 で訂正)。
   *
   * 1 稿目は docstring に「情報ペインが引く表と同じ物である」と書いていたが、
   * 🔴 **左辺も右辺も `entryActionHint` を同じ引数で呼ぶ同語反復**だった ──
   * `InspectorRenderer` を 1 度も import していないので、**原理的に確かめられない**。
   * 🔑 その主張は `tests/adapter/inspector-titles.test.ts`(実物の DOM と突き合わせる)へ移した。
   *
   * ここが守るのは 1 つだけ:**配るときに別の操作の字とすり替えない**。
   * ⚠ 弱いと自覚して置く(CLAUDE.md「取り出せないものは原文 pin で妥協するが、
   * 弱いと自覚して使う」の同型)。
   */
  it('⚠ 配る説明は、その操作自身の字である(別の操作の字とすり替えない)', () => {
    for (const a of entryMenuActions({ archetype: 'text', linkedFile: null }))
      expect(a.hint, `${a.action} の説明が表と違う`).toBe(entryActionHint(a.action, {
        archetype: 'text',
        linkedFile: null,
      }));
  });

  /**
   * 🔴 **本文の右クリックにも説明が届く**(動線レビュー 欠陥 2)。
   * ⚠ `adopt-external-images` は**本文の右クリックにしか無い**(マニュアル「画面を組み替える」)ので、
   *   ここが黙ると「押すと外へ通信します」がどこにも出ない。
   */
  it('🔴 本文のメニューも説明を配る(外へ通信する 1 個を黙らせない)', () => {
    const rows = bodyMenuActions({ externalImages: 3 });
    const adopt = rows.find((a) => a.action === 'adopt-external-images');
    expect(adopt?.hint, '外へ通信することが説明に無い').toContain('通信します');
    /**
     * ⚠ **対照群** ── 説明を持たない 1 つは空のまま(何にでも字を付ける作りではない)。
     * 🔴 **名前で等値 pin する**(2026-09-04)── 1 稿目は
     *   `BODY_MENU_ACTIONS.map(...)` と比べていたので「**本文のメニューは全部
     *   説明を持たない**」を主張していた。⚠ 説明を持つ項目を 1 つ足した瞬間に
     *   落ちる形で、**守りたいこと(説明が要る物には配る)と逆向き**だった。
     * ⚠ 2026-09-05(#633 段①): `pin-split` は説明を持った(帯の札の話を押す前に読める)ので、
     *   残るのは段組みだけ。
     */
    expect(
      rows.filter((a) => a.hint === '').map((a) => a.action),
      '説明を持たない項目の一覧が変わった',
    ).toEqual(['cycle-read-columns']);
    expect(
      rows.find((a) => a.action === 'pin-split')?.hint ?? '',
      'スタックに載せる の説明が帯の話をしていない',
    ).toContain('帯');
    // ⚠ **空振り防止** ── 名前で pin した 2 つが、いまも本文のメニューに居ること
    expect(
      BODY_MENU_ACTIONS.map((a) => a.action),
      '本文のメニューの顔ぶれが変わった(上の名指しが古い)',
    ).toEqual(['cycle-read-columns', 'pin-split', 'open-note-window']);
  });

  it('⚠ 知らない綴りには空を返す(呼び側が例外で落ちない)', () => {
    expect(entryActionHint('no-such-action', { archetype: null, linkedFile: null })).toBe('');
  });
});

/**
 * 🔴 **小窓の字と並び**(#690 I1 / I2、2026-09-04)。
 *
 * ⚠ I1: ボタンだけ「別の窓で開く」で、お知らせ・マニュアル・止めたときの字は全部
 *   「ウィンドウ」だった ── 同じ物に 2 つの呼び名を作らない。
 * ⚠ I2: #685 の 2 稿目は「別の窓で開く」を 2 番目に入れたので、clipboard へ写す 2 つ
 *   (参照をコピー / 素の Markdown)の**間に割り込んでいた**。写す 2 つを隣に戻し、
 *   小窓はその次。⚠ 情報ペインの並びは `tests/adapter/inspector-titles.test.ts` が pin する。
 */
/**
 * 🔴 **左の列の行から整理ができる 3 つ**(#215)。
 *
 * ⚠ 直す前、行の右クリックでフォルダにできることは「フォルダを書き出す」の 1 件だけで、
 *   改名は 2 ペインの `F2` にしか無かった(左の列には口が 1 つも無い)。
 * 🔑 **既存の並びを動かさない**(user 裁定 2026-09-04)── だから履歴の下・削除の上。
 */
describe('行の右クリックからの整理(#215)', () => {
  const acts = (ctx: { archetype: string | null; linkedFile: string | null }): string[] =>
    entryMenuActions(ctx).map((a) => a.action);

  it('🔴 「名前を変える」「移す…」はどの行にも出る', () => {
    for (const ctx of [
      { archetype: 'text', linkedFile: null },
      { archetype: 'folder', linkedFile: null },
      { archetype: null, linkedFile: null },
    ]) {
      expect(acts(ctx), `${JSON.stringify(ctx)} で改名が出ない`).toContain('rename-entry-begin');
      expect(acts(ctx), `${JSON.stringify(ctx)} で移すが出ない`).toContain('move-to-folder');
    }
  });

  it('🔴 「この中に新しいノートを作る」はフォルダのときだけ(ノートの中には作れない)', () => {
    expect(acts({ archetype: 'folder', linkedFile: null })).toContain('create-in-folder');
    expect(acts({ archetype: 'text', linkedFile: null })).not.toContain('create-in-folder');
    // ⚠ 種類が分からないときは**出さない側**へ倒す(`export-folder` と同じ)
    expect(acts({ archetype: null, linkedFile: null })).not.toContain('create-in-folder');
  });

  it('🔑 既存の並びを動かさない ── 3 つは履歴の下・削除の上に居る', () => {
    const a = acts({ archetype: 'folder', linkedFile: 'memo.md' });
    for (const x of ['rename-entry-begin', 'move-to-folder', 'create-in-folder']) {
      expect(a.indexOf(x), `${x} が履歴より上に居る(既存の並びを動かした)`).toBeGreaterThan(
        a.indexOf('show-history'),
      );
      expect(a.indexOf(x), `${x} が削除より下に居る`).toBeLessThan(a.indexOf('delete-entry'));
    }
    // ⚠ 3 つの中の並びも固定(改名 → 移す → 作る)── 面ごとに順が違うと探し直しになる
    expect(a.slice(a.indexOf('rename-entry-begin'), a.indexOf('delete-entry'))).toEqual([
      'rename-entry-begin',
      'move-to-folder',
      'create-in-folder',
    ]);
  });

  it('字は画面で起きることで書いてある', () => {
    expect(ENTRY_ACTION_LABELS['rename-entry-begin']).toBe('名前を変える');
    expect(ENTRY_ACTION_LABELS['move-to-folder']).toBe('フォルダへ移す…');
    expect(ENTRY_ACTION_LABELS['create-in-folder']).toBe('この中に新しいノートを作る');
  });
});

/**
 * 🔴 **スタックの字は 1 つの語**(#633 段①。user 裁定 2026-09-02 設問 3 = A)。
 *
 * ⚠ 段① の着地時、右クリックの字だけ「このノートを横に留める」のまま残っていた ──
 *   帯の名前は「スタック」、枠の字は「× 降ろす」、マニュアルは同じ節で
 *   「横に留める」と「スタックに載せる」の 2 つの名前を使っていた。
 *   帯に並んだ物と押した物の対応が読めない形である。
 * 🔑 押す字とマニュアルの字を**同じ文字列**で pin する(片方だけ直る日を作らない)。
 */
describe('スタックの字(#633 段①)', () => {
  it('🔴 本文のメニューの字は「このノートをスタックに載せる」で、マニュアルも同じ字を使う', () => {
    const label = BODY_MENU_ACTIONS.find((a) => a.action === 'pin-split')?.label;
    expect(label).toBe('このノートをスタックに載せる');
    const manual = readFileSync('docs/manual.md', 'utf-8');
    expect(manual, 'マニュアルに押す字が無い').toContain(`**${label}**`);
    // ⚠ 古い字が 1 つでも残ると、同じ節に 2 つの名前が並ぶ(直す前の姿)
    expect(manual, 'マニュアルに古い字「横に留める」が残っている').not.toContain('横に留める');
  });
});

describe('小窓の字と並び(#690 I1 / I2)', () => {
  it('🔴 字は「別のウィンドウで開く」(右クリックと本文のメニューの両方)', () => {
    const labels = [...ENTRY_MENU_ACTIONS, ...BODY_MENU_ACTIONS]
      .filter((a) => a.action === 'open-note-window')
      .map((a) => a.label);
    expect(labels, '2 つのメニューの両方に出ていない').toHaveLength(2);
    expect(new Set(labels), '2 つのメニューで字が違う').toEqual(new Set(['別のウィンドウで開く']));
    // ⚠ 「窓」の字に戻していない(お知らせ・マニュアルは「ウィンドウ」)
    for (const l of labels) expect(l, '「別の窓で開く」に戻っている').not.toBe('別の窓で開く');
  });

  it('🔴 右クリックの並びは 参照をコピー / 素の Markdown / 別のウィンドウで開く', () => {
    expect(ENTRY_MENU_ACTIONS.slice(0, 3).map((a) => a.action)).toEqual([
      'copy-entry-ref',
      'copy-plain-markdown',
      'open-note-window',
    ]);
  });
});

/**
 * 🔴 **表の形を変える字は 2 つ在り、向きが揃っていること**(#708 段② / 裁定②)。
 *
 * ⚠ 入口が 2 つ在る:右クリックのメニュー(`tableMenuActions`)と、
 *   表の右上の「▾」の小窓(`tableConvertPickLabel`)── 指で触る端末には
 *   右クリックが無いので、**後者が唯一の入口**である。
 * ⚠ 字が**別に要る**のは文脈が違うから ── 小窓ではコピーの形が 5 つ並んだ下に
 *   出るので、「CSV の表にする」だと「**CSV でコピーする**」と読める。
 * 🔑 だが**向き**(どちらの形にするか)は同じでなければならない ──
 *   片方だけ逆になると、同じ表に対して 2 つの入口が反対のことを言う。
 */
describe('表の形を変える字(#708)', () => {
  it('🔴 出るのは 1 つだけで、いまの形の反対側である', () => {
    expect(tableMenuActions({ from: 'markdown' }).map((a) => a.action)).toEqual(['table-to-csv']);
    expect(tableMenuActions({ from: 'csv' }).map((a) => a.action)).toEqual(['table-to-markdown']);
  });

  it('🔴 2 つの入口の字が、同じ向きを指している', () => {
    for (const from of ['markdown', 'csv'] as const) {
      const menu = tableMenuActions({ from })[0]!;
      const pick = tableConvertPickLabel(from);
      // 🔑 行き先の名前(`CSV` / `Markdown`)が両方に在り、**同じ側**を指す
      const want = from === 'markdown' ? 'CSV' : 'Markdown';
      const other = from === 'markdown' ? 'Markdown' : 'CSV';
      expect(menu.label, `メニューの字が行き先を言っていない(${from})`).toContain(want);
      expect(pick, `小窓の字が行き先を言っていない(${from})`).toContain(want);
      expect(pick, `小窓の字が逆を指している(${from})`).not.toContain(other);
    }
  });

  /**
   * ⚠ **小窓の字は「本文が変わる」と分かる形にする** ── 周りはコピーの一覧なので、
   *   そう書かないと「コピーの形が 1 つ増えた」と読める。
   */
  it('⚠ 小窓の字は「本文を…書き換える」と読める', () => {
    for (const from of ['markdown', 'csv'] as const) {
      const pick = tableConvertPickLabel(from);
      expect(pick, `本文が変わると読めない(${from})`).toContain('本文を');
      expect(pick, `書き換えると読めない(${from})`).toContain('書き換える');
    }
  });
});

/**
 * 🔴 **刻みの一覧は「押しても何も起きない項目」を並べない**(#855 段 0 の 3 つ目)。
 */
describe('繰り返しの一覧(#855 段 0)', () => {
  it('🔴 いまの刻みは出さない / 繰り返していなければ「やめる」も出さない', () => {
    expect(repeatMenuActions(null).map((a) => a.label)).toEqual(['毎日', '毎週', '毎月', '毎年']);
    expect(repeatMenuActions('week').map((a) => a.label)).toEqual([
      '毎日',
      '毎月',
      '毎年',
      'やめる',
    ]);
  });

  it('🔴 どの項目も、刻みの綴りを属性で持つ(「やめる」は空)', () => {
    const items = repeatMenuActions('week');
    expect(items.map((a) => a.attrs[REPEAT_ATTR])).toEqual(['day', 'month', 'year', '']);
    // ⚠ 空振り防止 ── 属性の名前そのものが変わったら落ちる
    expect(REPEAT_ATTR).toBe('data-pkc-repeat');
  });

  it('⚠ 説明は 1 件残らず付いている(右クリックの項目が黙らない)', () => {
    for (const a of [TASK_REPEAT_MENU_ACTION, ...repeatMenuActions('week')])
      expect(a.hint, `「${a.label}」に説明が無い`).not.toBe('');
  });
});

/**
 * 🔴 **名前の幅の「上限」は置かない**(#1029 段 C。**1 稿目を実測で覆した記録**)。
 *
 * ⚠ 1 稿目はここに「全角 6 字(12 桁)以内」という門が在った ── 名前から動詞を落とし、
 *   動詞は**塊の見出し**に言わせる設計だったからである。
 * 🔴 **実測で覆った**(2026-09-21、実ブラウザ・8 幅・同じ頁で A/B):見出しを出すと
 *   右の列の折り返しが **+2〜+4 段**増えた(1600px で +4 段)。設計 doc §4.0 の
 *   「2 段以上増えるなら見出しをやめて名前を作り直す」に当たるので、**見出しを出さず、
 *   名前は動詞を持ったまま**にした。
 * ⚠ だから**上限の門は外してある** ── 動詞を含む名前は 12 桁に収まらない
 *   (「この中に新しいノートを作る」は 26 桁)。⚠ この節を消さないこと:
 *   消すと、次に読む人が**上限の門をもう一度足して、同じ実測をやり直す**。
 * 🔑 いま幅のでこぼこを受けているのは**下限の段 2 つ**(すぐ下)である。
 */

/**
 * 🔴 **幅は「段」で受ける。段は 2 つだけ**(#1029 段 C 手 2 門④)。
 *
 * ⚠ 「CSS を走査して、段の値が 2 種類であることを見る」門 ── 見るのは
 *   **実行する規則**(`min-width: max(<段>, max-content)`)だけである
 *   (CLAUDE.md §1「範囲が広すぎて無関係な散文に満たされる」と同じ罠を避けるため、
 *   コメントを含む file 全体の文字列一致ではなく**構文で拾う**)。
 */
describe('幅の段は 2 つだけ(#1029 段 C 手 2)', () => {
  /**
   * 🔴 **#1046 で「短い段」の在庫が尽きた**(2026-09-25)。
   *
   * ⚠ 上のブロックで「両方実際に使う」を空振り防止として置いていたが、
   *   `#1046`(動詞つきの改名)が **この配列の短い 6 件を全部**長い側へ動かした ──
   *   `Word`(4)→`Word で書き出す`(15)/ `PDF`(3)→`PDF で書き出す`(14)/
   *   `書き戻す`(8)→`元ファイルへ書き戻す`(20)/ `履歴`(4)→`履歴を開く`(10)/
   *   `移す…`(6)→`フォルダへ移す…`(16)/ `削除`(4)→`ゴミ箱へ移す`(12)。
   *   実測(2026-09-25 時点):この配列に 8 桁以下の項目は **0 件**。
   * 🔑 これは検査が弱ったのではない ── **短い段を使う項目が、いま実在しない**。
   *   `entryActionWidthTier` と CSS の `[data-pkc-width='short']` は
   *   **将来また短い名前が増えたときのための機構として残す**(消さない)。
   * ⚠ だから「両方使う」ではなく「2 値しか無い(3 段目を作らない)」だけを見る形に
   *   落とす。短い段が復活したら、この it は自動で both を見る形に戻せる
   *   (下の対照群を、その日のために残してある)。
   */
  it('🔴 entryActionWidthTier は short/long の 2 値だけ(いまは全部 long でもよい)', () => {
    const tiers = new Set(ENTRY_MENU_ACTIONS.map((a) => entryActionWidthTier(a.label)));
    for (const t of tiers) expect(['short', 'long']).toContain(t);
    // ⚠ 空振り防止 ── 配列自体は読めていること
    expect(ENTRY_MENU_ACTIONS.length).toBeGreaterThan(5);
    // 🔑 いまの実態を pin する(#1046)── 復活したら、ここが教えてくれる
    expect([...tiers].sort()).toEqual(['long']);
  });

  it('⚠ 対照群 ── 8 桁以下の名前を渡せば、いまも short が返る(関数は生きている)', () => {
    expect(entryActionWidthTier('移す…')).toBe('short');
    expect(entryActionWidthTier('削除')).toBe('short');
  });

  it('🔴 CSS に現れる幅の段(min-width の下限)は 2 種類だけ', () => {
    const css = readFileSync('src/styles/app.css', 'utf-8');
    // 🔑 実行する宣言だけを拾う(`min-width: max(4em, max-content)` の形)
    const values = [...css.matchAll(/min-width:\s*max\(([0-9.]+em),\s*max-content\)/g)].map(
      (m) => m[1]!,
    );
    // ⚠ 空振り防止 ── 規則そのものが 0 件なら「2 種類」の主張が意味を持たない
    expect(values.length, '段の規則が CSS に無い(空振り)').toBeGreaterThanOrEqual(2);
    expect(new Set(values).size, '段が 2 種類ではない(3 つ目が生えた/1 つに潰れた)').toBe(2);
  });

  it('⚠ 全角 8 桁がちょうど境目(短 ≤ 8 / 長 > 8)', () => {
    expect(entryActionWidthTier('Markdown')).toBe('short'); // 8 桁ちょうど
    expect(entryActionWidthTier('スタック')).toBe('short'); // 8 桁ちょうど
    expect(entryActionWidthTier('PowerPoint')).toBe('long'); // 10 桁
    expect(entryActionWidthTier('バックアップ')).toBe('long'); // 12 桁
  });
});
