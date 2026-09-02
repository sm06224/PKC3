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
  ADOPT_IMAGES_LABEL,
  adoptImagesLabel,
  BODY_MENU_ACTIONS,
  bodyMenuActions,
  ENTRY_ACTION_HINTS,
  ENTRY_ACTION_HINT_MAX,
  ENTRY_ACTION_LABELS,
  ENTRY_MENU_ACTIONS,
  entryActionHint,
  entryMenuActions,
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

    const dead = ENTRY_MENU_ACTIONS.filter((a) => !have.has(a.action)).map((a) => a.action);
    expect(dead, '受け手のいない操作をメニューに出している(押しても無言)').toEqual([]);
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
    for (const a of ENTRY_MENU_ACTIONS) {
      expect(
        inspector.includes(`ENTRY_ACTION_LABELS['${a.action}']`),
        `情報ペインが「${a.label}」の字を自前で持っている(表から引いていない)`,
      ).toBe(true);
      // ⚠ 直書きが**戻っていない**ことも見る(引きつつ横に直書きを残せてしまう)
      expect(
        inspector.includes(`btn('${a.action}', '${a.label}')`),
        `情報ペインに「${a.label}」の直書きが残っている`,
      ).toBe(false);
    }
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
    expect(ENTRY_ACTION_LABELS['export-folder']).toBe('フォルダを書き出す');
    expect(ENTRY_ACTION_LABELS['write-back-file']).toBe('書き戻す');
    // ⚠ 取り込みは枚数を含むので表ではなく組み立て関数が持つ
    expect(adoptImagesLabel(1)).toContain(ADOPT_IMAGES_LABEL);
  });
});

/**
 * 🔴 **右クリックの項目も説明を持つ**(#587 改善 C-1)。
 *
 * ⚠ 直す前は**情報ペインの 11 個だけ**が説明を持ち、**右クリックの 9 個は 9 個とも空**
 *   だった(実測 2026-08-29)。同じ字・同じ操作なのに、片方だけ黙っていた。
 * 🔑 しかも右クリックは「右の列を畳んだ人のための 2 本目の道」(マニュアル §4)なので、
 *   **説明が要るのはむしろこちら**である。
 *
 * ⚠ **「鍵が在るか」だけを見ない**(§1)── 値が空文字でも鍵は在る。
 *   ここは**配られた側**(`entryMenuActions` の返り値)で、**中身が空でない**ことを見る。
 */
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
      ['export-entry', '41c58db6'],
      ['export-entry-html', '7f0a31b1'],
      ['export-folder', '5636e4f5'],
      ['export-entry-docx', 'e79a6f86'],
      ['export-entry-pptx', '60bcb9ea'],
      ['export-entry-pdf', 'c9838f51'],
      ['adopt-external-images', '36c7974a'],
      ['copy-entry-ref', '2614a326'],
      ['copy-plain-markdown', '73e9b322'],
      ['show-history', '2511b05b'],
      ['delete-entry', '661f5844'],
      // 🔴 **左の列の道具 4 つ**(#632 段①)── 本文ページの ⋯ から押せるようにした
      [// ⚠ 2026-09-02: 「このノートの添付にします」は**嘘**だった(`attach.ts` は
    //    `selectedLid` を 1 度も読まず、独立した添付のノートを作る)ので事実へ直した
    'attach-file', '02ac704c'],
      ['start-audio-capture', '6313fe2e'],
      ['start-screen-capture', 'ec055655'],
      ['start-timer', '97214aee'],
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

  /** ⚠ 条件つきの 2 つも出る文脈 ── これを使わないと 2 行が**一度も検められない**。 */
  const ALL = { archetype: 'folder', linkedFile: 'メモ.md' } as const;

  it('🔴 出る項目は 1 つ残らず説明を持つ(足した人がここで気づく)', () => {
    const rows = entryMenuActions(ALL);
    // ⚠ 空振り防止 ── 条件つきの 2 つを含めて全部出ている
    expect(rows.length, '条件つきの行が出ていない(台の前提が崩れている)').toBe(
      ENTRY_MENU_ACTIONS.length,
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
      `開いた元のファイル(${long})を、このノートの内容で上書きします`.length,
      '前提が崩れている: この名前では上限を超えない',
    ).toBeGreaterThan(ENTRY_ACTION_HINT_MAX);
    const h = entryActionHint('write-back-file', { archetype: 'text', linkedFile: long });
    expect(h.length, '2 行に収まらない').toBeLessThanOrEqual(ENTRY_ACTION_HINT_MAX);
    expect(h, '取り消せないことを言う末尾が切れている').toContain('上書きします');
    // 🔑 頭と尻の両方を残す ── 頭だけだと拡張子が消え、尻だけだとどの文書か分からない
    expect(h, 'どの文書か分からない').toContain('2026年度');
    expect(h, '拡張子が消えている').toContain('.docx');
    // ⚠ **対照群** ── 短い名前は 1 字も縮めない
    expect(
      entryActionHint('write-back-file', { archetype: 'text', linkedFile: 'メモ.md' }),
      '短い名前まで縮めている',
    ).toBe('開いた元のファイル(メモ.md)を、このノートの内容で上書きします');
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
   * ⚠ `adopt-external-images` は**本文の右クリックにしか無い**(マニュアル §4)ので、
   *   ここが黙ると「押すと外へ通信します」がどこにも出ない。
   */
  it('🔴 本文のメニューも説明を配る(外へ通信する 1 個を黙らせない)', () => {
    const rows = bodyMenuActions({ externalImages: 3 });
    const adopt = rows.find((a) => a.action === 'adopt-external-images');
    expect(adopt?.hint, '外へ通信することが説明に無い').toContain('通信します');
    // ⚠ **対照群** ── 説明を持たない 2 つは空のまま(何にでも字を付ける作りではない)
    expect(
      rows.filter((a) => a.hint === '').map((a) => a.action),
      '説明を持たない項目の一覧が変わった',
    ).toEqual(BODY_MENU_ACTIONS.map((a) => a.action));
  });

  it('⚠ 知らない綴りには空を返す(呼び側が例外で落ちない)', () => {
    expect(entryActionHint('no-such-action', { archetype: null, linkedFile: null })).toBe('');
  });
});
