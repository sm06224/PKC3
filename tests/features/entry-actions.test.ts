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
  bodyMenuActions,
  ENTRY_ACTION_LABELS,
  ENTRY_MENU_ACTIONS,
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
