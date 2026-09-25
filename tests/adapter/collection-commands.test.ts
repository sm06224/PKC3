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
     * 🔴 **2026-09-21(#1017 段③-1)に「保存領域」の型で並べ直した**
     *   (`docs/development/ui-total-design-2026-09.md` §3.2)。`buildSettingsCommands()`
     *   はいま「保存領域」の 3 つの h4(容量の内訳 / 使っていない添付 /
     *   保存領域の点検)だけを組む ── 「設定の持ち出し」
     *   (`export-settings` / `apply-settings`)は「システム → 設定」へ移り、
     *   この関数の返す物には無い。
     */
    expect(buttons).toEqual([
      // 🔴 何が容量を食っているか(#415)── 片づけの**前**(どれが重いか分からないと片づけられない)
      'storage-profile',
      ...SETTINGS_COMMANDS.map((c) => c.action),
      /**
       * 🔴 **壊れたときに調べる口**(#971 段③)── 容量の**隣**に置く。
       * ⚠ これも「逃がした操作」ではないので `SETTINGS_COMMANDS` には入れず、
       *   この面の中に別の塊として置いてある。
       *
       * 🔴 **2026-09-21(#1017 段④b)に、専用の取り出しボタン 2 つを退役させた**
       *   (`db-rescue-archive` / `db-rescue`)。保存領域に問題があるときは、
       *   いつもの「バックアップ」/「Markdown」が自動で読める分だけを集める
       *   (`src/adapter/ui/actions/export-archive.ts`)。
       */
      'db-check',
      /**
       * 🔴 **見出し「壊れて直らないときの、最後の手」を廃止し、押し口 1 つで
       *   開閉する箱にした**(2026-09-21、#1017 段③-1。`ui-total-design-2026-09.md`
       *   §6.1「評価語・脅し語を使わない」── 「最後の手」に抵触するため)。
       */
      'toggle-container-repair',
      /**
       * 🔴 **並びがそのまま「まず試す順」である**(user 裁定 2026-09-18)──
       *   上が**作り直す**、下が**初期化する**。⚠ 逆に並べると、
       *   壊れた人が**先に取り消せないほう**を読む。
       */
      'container-rebuild',
      'container-reset',
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
 *
 * 🔴 **2026-09-21(#1017 段④b)に、専用の取り出しボタン 2 つを退役させた**。
 * ⚠ 直す前はここで「戻せる形」「読める形」の 2 つの違いを見える字で見ていたが、
 *   その 2 つは無くなった ── いまは残った「壊れていないか調べる」の説明が
 *   **次の一手(バックアップ)を見える字で言っているか**だけを見る。
 */
describe('壊れたときの口は、見える字で説明する(2026-09-17 / 2026-09-21)', () => {
  /** 面の**見える字**だけを集める(`title` は読まない)。 */
  const visibleText = (el: HTMLElement): string =>
    [...el.querySelectorAll('p')].map((p) => p.textContent ?? '').join('\n');

  it('🔴 「壊れていないか調べる」は、次の一手(バックアップ)を見える字で言う', () => {
    const box = buildSettingsCommands().querySelector<HTMLElement>(
      '[data-pkc-region="db-rescue"]',
    )!;
    const seen = visibleText(box);
    const backupLabel = COLLECTION_COMMANDS.find((c) => c.action === 'export-archive')?.label;
    expect(backupLabel, 'バックアップ口が一覧から消えた').toBeTruthy();
    expect(seen, '次に何を押すか見える字で言っていない').toContain(backupLabel as string);
  });

  /**
   * ⚠ **空振り防止(向きは「無いこと」なので、足す側で検める)** ──
   *   説明を `title` へ戻しただけでは通らないことを見る。
   */
  it('⚠ 説明は `title` ではなく、見える字の側に在る', () => {
    const box = buildSettingsCommands().querySelector<HTMLElement>(
      '[data-pkc-region="db-rescue"]',
    )!;
    const note = box.querySelector<HTMLElement>('[data-pkc-field="db-check-run-note"]');
    expect(note, 'db-check-run に見える説明が無い').not.toBeNull();
    expect((note?.textContent ?? '').length, 'db-check-run の説明が空').toBeGreaterThan(10);
    expect(note?.hidden, 'db-check-run の説明が隠れている').toBe(false);
  });
});
