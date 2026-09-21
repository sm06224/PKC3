/** @vitest-environment happy-dom */
/**
 * 🔴 **動線が「どこにも無い」状態を作らせない**(#239)。
 *
 * user 指示 2026-08-17「左下にあっても使う頻度が低いボタンは設定画面に逃すこと」で、
 * ノート全体の操作は **左の列**と**設定**の 2 か所に分かれた。
 *
 * ⚠ この形の怖いところは、**片方から消して、もう片方へ足し忘れたときに黙ること**である:
 * - `repo-hygiene` の「受け手のいない `data-pkc-action`」は**逆向き**なので鳴らない
 *   (押す口が消えて受け手だけが残る形)
 * - 画面は普通に描かれる ── 無いものは見えないだけで、エラーも警告も出ない
 * - マニュアル突合(`docs-parity`)は**在るものの文言**を見るので、消えた物は素通りする
 *
 * 🔑 だから **合計**を pin する。片方から外したら、もう片方に足すまで落ちる。
 *
 * ## 2026-09-21 追記(#1017 段④a)
 *
 * ⚠ 場所は**3 か所**になった ── コレクション全体の書き出し 4 つは
 * 「設定」から**右の列(何も選んでいないとき)**へ移った(`COLLECTION_PANE_COMMANDS`)。
 * `tests/adapter/collection-pane.test.ts` が右の列に実際に描かれることを見る。
 */
import { describe, expect, it } from 'vitest';
import {
  COLLECTION_COMMANDS,
  COLLECTION_PANE_COMMANDS,
  SETTINGS_COMMANDS,
  buildSettingsCommands,
} from '../../src/adapter/ui/render/commands';

/**
 * 2026-08-17 の分割時点の全数 + #1017 段④a で場所が動いた 4 つ。
 * ⚠ **減らすときは user の裁定が要る**(動線が減る)。
 */
const ALL_ACTIONS = [
  'export-archive',
  'export-html',
  'export-markdown',
  // 🔴 可搬単一 HTML(#400 段④)── 「閲覧用 HTML」とは別の口である
  'export-portable',
  // 🔴 構成をテキストでコピー(#429 段①)── AI に整理を頼むための材料
  'export-structure',
  'import-file',
  'purge-orphan-assets',
] as const;

describe('ノート全体の操作の置き場(#239 / #1017 段④a)', () => {
  it('🔴 合計が変わっていない ── どこからも消えていない', () => {
    const all = [...COLLECTION_COMMANDS, ...COLLECTION_PANE_COMMANDS, ...SETTINGS_COMMANDS]
      .map((c) => c.action)
      .sort();
    expect(all).toEqual([...ALL_ACTIONS]);
  });

  it('🔴 3 か所に同じものを置かない(押した場所で挙動が違う、を作らない)', () => {
    const left = COLLECTION_COMMANDS.map((c) => c.action);
    const pane = COLLECTION_PANE_COMMANDS.map((c) => c.action);
    const inSettings = SETTINGS_COMMANDS.map((c) => c.action);
    expect(left.filter((a) => pane.includes(a) || inSettings.includes(a))).toEqual([]);
    expect(pane.filter((a) => inSettings.includes(a))).toEqual([]);
  });

  it('🔴 左の列に残すのは「よく押す / 押せないと詰まる」もの', () => {
    // ⚠ 等値で見る ── ここが緩いと、逃がしすぎ(左が空)も素通りする
    expect(COLLECTION_COMMANDS.map((c) => c.action)).toEqual(['import-file', 'export-archive']);
  });

  it('🔴 逃がした先で、実際に押せる形で描かれている', () => {
    const el = buildSettingsCommands();
    // ⚠ **描いた物**を見る(一覧の定数を見るだけでは、描き忘れが素通りする)
    const buttons = [...el.querySelectorAll('button[data-pkc-action]')].map((b) =>
      b.getAttribute('data-pkc-action'),
    );
    /**
     * ⚠ **等値のまま**にする(黙って増えた口を見逃さない)。
     * 🔴 2026-08-26 に `apply-plan` が 1 つ増えた(#429 段③)── これは
     *   「逃がした操作」ではなく**「構成をコピー」の後半**なので
     *   `SETTINGS_COMMANDS` には入れず、この面の中に別の塊として置いてある。
     */
    expect(buttons).toEqual([
      ...SETTINGS_COMMANDS.map((c) => c.action),
      // 🔴 何が容量を食っているか(#415)── 片づけの**手前**なので同じ面に置く
      'storage-profile',
      /**
       * 🔴 **壊れたときの救出**(#971 段③)── 容量の**隣**に置く。
       * ⚠ これも「逃がした操作」ではないので `SETTINGS_COMMANDS` には入れず、
       *   この面の中に別の塊として置いてある。
       */
      'db-check',
      /**
       * 🔴 **戻せる形で書き出す**(#986、2026-09-16)── 直す前は下の 1 つだけで、
       *   出るのは **.md 1 枚**だった。⚠ それを取り込んでも**ノートは 1 件**に
       *   しかならないので(素の .md は 1 ファイル = 1 ノート)、
       *   **戻すための口**を足した。⚠ **読む側は消していない**。
       * ⚠ 並びもこの順である ── 壊れたときに user がやりたいのは
       *   「読む」ではなく「**元に戻す**」ほうだから、先に置く。
       */
      'db-rescue-archive',
      'db-rescue',
      /**
       * 🔴 **壊れて直らないときの、最後の手**(#986 段③ → #1006)。
       * ⚠ これも「逃がした操作」ではないので `SETTINGS_COMMANDS` には入れず、
       *   **別の見出しの塊**として置いてある ── 取り消せない操作を
       *   「調べる」の見出しの下に混ぜない。
       *
       * 🔴 **並びがそのまま「まず試す順」である**(user 裁定 2026-09-18)──
       *   上が**中身を残して作り直す**、下が**捨てる**。⚠ 逆に並べると、
       *   壊れた人が**先に取り消せないほう**を読む。
       */
      'container-rebuild',
      'container-reset',
      'apply-plan',
      /**
       * 🔴 **設定だけの持ち出し**(#414)── ⚠ **バックアップとは別物**である
       *   (あちらはノートごと移る)。だから `SETTINGS_COMMANDS`(左下から
       *   逃がした操作)には入れず、この面の中に別の塊として置いてある。
       */
      'export-settings',
      'apply-settings',
    ]);
    // ⚠ 畳んでいないこと(2026-08-03「主要な導線を畳まない」は生きている)
    expect(el.querySelectorAll('details')).toHaveLength(0);
    // ⚠ 説明の title も落とさない ── 元に戻せない操作が 1 つ混ざっている
    for (const c of SETTINGS_COMMANDS) {
      const btn = el.querySelector<HTMLElement>(`[data-pkc-action="${c.action}"]`);
      expect(btn?.title, `${c.action} の説明が消えた`).toBe(c.title);
    }
  });

  it('⚠ 「元に戻せません」と言い続ける(片づけの断り)', () => {
    const purge = SETTINGS_COMMANDS.find((c) => c.action === 'purge-orphan-assets');
    expect(purge?.title).toContain('元に戻せません');
  });
});

/**
 * 🔴 **ホバーしないと読めない説明を、判断の材料にしない**(user 指摘 2026-09-17)。
 *
 * user の求め(こちらの解釈):**取り消せない操作に関わる所は、説明的な画面にすること。**
 *
 * ⚠ 守りたいのは「説明が在る」ではなく「**指で触る端末でも読める形で在る**」である ──
 *   `title` は**ホバーでしか出ない**ので、スマホの user には 1 度も届かない。
 * 🔑 だから見るのは **`title` を 1 文字も読まずに**、面の**見える字**だけで
 *   判断できるか(= `title` を全部剥がしても、必要なことが残っているか)。
 */
describe('壊れたときの 3 つの口は、見える字で説明する(2026-09-17)', () => {
  /** 面の**見える字**だけを集める(`title` は読まない)。 */
  const visibleText = (el: HTMLElement): string =>
    [...el.querySelectorAll('p')].map((p) => p.textContent ?? '').join('\n');

  it('🔴 「戻せる形」は、取り込むとノートが戻ると見える字で言う', () => {
    const box = buildSettingsCommands().querySelector<HTMLElement>(
      '[data-pkc-region="db-rescue"]',
    )!;
    const seen = visibleText(box);
    // ⚠ 送り仮名で外さないよう、語幹まで(「戻ります」/「戻る」の両方に当たる)
    expect(seen, '戻せることを見える字で言っていない').toContain('ノートとして戻り');
    expect(seen, 'どこから戻すのかを言っていない').toContain('取り込む');
  });

  /**
   * 🔴 **これがいちばん大事な 1 行である。**
   * ⚠ 「読める形」だけ書き出して「中身を捨てる」を押した人は、戻すと**ノート 1 件**になる
   *   ── つまりこの選択は**取り消せない操作の前提条件**である。
   */
  it('🔴 「読める形」は、戻すためではないと見える字で言う', () => {
    const box = buildSettingsCommands().querySelector<HTMLElement>(
      '[data-pkc-region="db-rescue"]',
    )!;
    const seen = visibleText(box);
    expect(seen, '1 件になることを見える字で言っていない').toContain('1 件');
    expect(seen, '戻すためではないと言っていない').toContain('戻すためのものではありません');
  });

  it('🔴 迷ったときの逃げ道と、押しても中身が変わらないことを言う', () => {
    const box = buildSettingsCommands().querySelector<HTMLElement>(
      '[data-pkc-region="db-rescue"]',
    )!;
    const seen = visibleText(box);
    expect(seen, '迷ったときの逃げ道が無い').toContain('両方');
    // ⚠ 壊れたと聞いた直後の人は「押すと余計に壊れるのでは」で止まる
    expect(seen, '押しても中身が変わらないことを言っていない').toContain('変えません');
  });

  /**
   * ⚠ **空振り防止(向きは「無いこと」なので、足す側で検める)** ──
   *   説明を `title` へ戻しただけでは通らないことを見る。
   */
  it('⚠ 説明は `title` ではなく、見える字の側に在る', () => {
    const box = buildSettingsCommands().querySelector<HTMLElement>(
      '[data-pkc-region="db-rescue"]',
    )!;
    // 3 つのボタンそれぞれに、見える説明が 1 つずつ付いている
    for (const field of ['db-check-run', 'db-rescue-archive-run', 'db-rescue-run']) {
      const note = box.querySelector<HTMLElement>(`[data-pkc-field="${field}-note"]`);
      expect(note, `${field} に見える説明が無い`).not.toBeNull();
      expect((note?.textContent ?? '').length, `${field} の説明が空`).toBeGreaterThan(10);
      expect(note?.hidden, `${field} の説明が隠れている`).toBe(false);
    }
  });
});
