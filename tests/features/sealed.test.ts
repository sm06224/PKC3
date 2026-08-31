/** @vitest-environment happy-dom */
/**
 * 封印(`src/features/sealed.ts`)の **戻せる形**を見張る。
 *
 * 🔴 `docs-parity` が見ているのは「封印中のものが**導線に出ない**」だけである。
 * 封印の約束は 3 つあって、残る 2 つ ──「既存データを壊さない」「戻せる」──
 * は**どの test も見ていなかった**(2026-08-04、引き継ぎ先の指摘で判明)。
 * 描画器を消す / flavor の登録を外す / 抽出列を落とすのは**どれも緑のまま通る**ので、
 * 封印が「畳んだ」から「壊した」へ静かに変わりうる。ここがその歯止め。
 *
 * 🔴 もう 1 つ直したのは **`sealed.ts` の嘘**である。初版は「解くのは配列から
 * 1 語消すだけ」と書いていたが、それが本当なのは `todo` だけだった。
 * 散文は腐るので、**何が戻り、何が戻らないか**を機械で pin する
 * (下の「解いたときに実際に戻るもの」)。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SEALED_ARCHETYPES,
  SEALED_TEST_NOTES,
  SEALED_VIEWS,
  isSealedArchetype,
  isSealedView,
} from '@features/sealed';
import { getFlavor } from '@features/flavor';
import { SCHEMA_DDL } from '@adapter/platform/storage/schema';

/** 封印を解いた状態の shell を作る(`sealed.ts` を空配列に差し替えて import)。 */
async function buildShellWithSeal(sealed: {
  archetypes: readonly string[];
  views: readonly string[];
}): Promise<HTMLElement> {
  vi.resetModules();
  vi.doMock('@features/sealed', () => ({
    SEALED_ARCHETYPES: sealed.archetypes,
    SEALED_VIEWS: sealed.views,
    SEAL_REASON: '',
    SEALED_TEST_NOTES: '',
    isSealedArchetype: (a: string) => sealed.archetypes.includes(a),
    isSealedView: (v: string) => sealed.views.includes(v),
  }));
  const { buildShell } = await import('@adapter/ui/render/shell');
  const root = document.createElement('div');
  buildShell(root);
  return root;
}

const createKinds = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-pkc-field="create-kind"] option')].map(
    (o) => (o as HTMLOptionElement).value,
  );
const viewButtons = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-pkc-view]')].map((b) => b.getAttribute('data-pkc-view') ?? '');

describe('封印 ── 畳んであるが、壊してはいない', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('@features/sealed');
  });

  it('🔴 封印している対象が pin と一致する(黙って増減しない)', () => {
    // ⚠ **等値**で見る。包含だと足したものが素通りする
    expect([...SEALED_ARCHETYPES]).toEqual(['todo', 'form']);
    /**
     * 🔴 **面の封印は 2026-08-19 に全部解けた**(カレンダー #276 / カンバン #277)。
     * ⚠ 空になっても配列は消さない ── 次に畳むときの受け皿であり、
     *   `isSealedView` の口でもある(下の 2 行がその生存確認)。
     */
    expect([...SEALED_VIEWS]).toEqual([]);
    // 判定関数と配列が食い違わないこと(片方だけ直す事故を止める)
    expect(SEALED_ARCHETYPES.every(isSealedArchetype)).toBe(true);
    expect(SEALED_VIEWS.every(isSealedView)).toBe(true);
    expect(isSealedArchetype('text')).toBe(false);
    expect(isSealedView('list')).toBe(false);
  });

  /**
   * 🔴 **2026-08-23 に主張を書き直した**(#292 段⑤)。
   *
   * ⚠ ここは「封印した面の描画器が生きている(解くときに書き直しにならない)」を
   *   見ていたが、**中央のカレンダー / 板そのものが無くなった** ── 予定は
   *   **左の列の「予定」タブ**になり、描画器は `render/schedule.ts` である。
   * 🔑 だから見るのは「消されていないこと」ではなく「**引っ越し先が在ること**」。
   */
  it('🔴 予定の面と、その材料が生きている', async () => {
    const [scheduleUi, agenda, kanbanData, calendarData] = await Promise.all([
      import('@adapter/ui/render/schedule'),
      import('@features/schedule/agenda'),
      import('@features/schedule/task-cards'),
      import('@features/schedule/month-grid'),
    ]);
    expect(typeof scheduleUi.ScheduleRenderer).toBe('function');
    expect(typeof agenda.buildAgenda).toBe('function');
    // ⚠ 札の組み立てと月の格子は**引っ越しても同じもの**を使う
    expect(typeof kanbanData.taskCardsOf).toBe('function');
    expect(typeof calendarData.getMonthGrid).toBe('function');
  });

  it('🔴 封印中の archetype の flavor が登録されたままである(既存 entry が読める)', () => {
    for (const archetype of SEALED_ARCHETYPES) {
      // ⚠ `getFlavor` は未知の archetype を text へ落とすので、
      //    「例外が出ない」では足りない ── **自分の flavor が返る**ことを見る
      expect(getFlavor(archetype).archetype, `${archetype} の flavor が登録から外れている`).toBe(
        archetype,
      );
    }
  });

  it('🔴 抽出列が schema に残っている(落とすと再開時に戻せない)', () => {
    const entries = SCHEMA_DDL.find((sql) => /CREATE TABLE IF NOT EXISTS entries\b/.test(sql));
    expect(entries, 'entries テーブルの DDL が見つからない').toBeDefined();
    for (const column of ['status', 'date', 'archived']) {
      expect(entries, `抽出列 ${column} が entries から消えている`).toMatch(
        new RegExp(`^\\s*${column}\\s`, 'm'),
      );
    }
    // 引く側の索引も一緒に(列だけ残って索引が消えると kanban / calendar が遅くなる)
    expect(SCHEMA_DDL.join('\n')).toMatch(/idx_entries_status/);
    expect(SCHEMA_DDL.join('\n')).toMatch(/idx_entries_date/);
  });

  it('🔴 封印が効いているのは、shell が配列を見ているからである', async () => {
    const sealedRoot = await buildShellWithSeal({ archetypes: ['todo', 'form'], views: ['kanban'] });
    expect(createKinds(sealedRoot)).not.toContain('todo');
  });

  /**
   * 🔴 **解いたときに実際に戻るもの / 戻らないもの**。
   *
   * `sealed.ts` の散文が「1 語消すだけ」と嘘をついていたので、ここで機械化する。
   * ⚠ この test が落ちたら、それは**封印が壊れた**のではなく
   * **解くのに要る手当てが変わった**ということ ── `sealed.ts` の記述を直す。
   */
  it('🔴 解いて戻るのは todo だけ(form / kanban は導線の作り直しが要る)', async () => {
    const opened = await buildShellWithSeal({ archetypes: [], views: [] });

    // todo … 配列から消すだけで戻る(`CREATE_BUTTONS` に項目が残っているから)
    expect(createKinds(opened), 'todo が配列を空にしても戻らない ── 濾していた前提が崩れた').toContain(
      'todo',
    );

    // form … 消しても戻らない(作成導線がそもそも無い)
    expect(
      createKinds(opened),
      'form が戻った ── 作成導線が足されたので sealed.ts の記述を直す',
    ).not.toContain('form');

    /**
     * kanban … 配列を空にしても**上の帯には戻らない**(P8 段⑤ で `VIEW_BUTTONS` が
     * 設定 1 つになった)。⚠ #277 で解いた後も**ここは変わらない** ── 戻した
     * 導線は組み込みタイル(下の test)であって、帯の切替ではない。
     */
    for (const view of ['kanban', 'calendar']) {
      expect(
        viewButtons(opened),
        `${view} の切替が帯に戻った ── 導線の置き場が変わったので sealed.ts の記述を直す`,
      ).not.toContain(view);
    }
  });

  /**
   * 🔴 **2 ペインは組み込みタイルから開ける**(#241)。
   *
   * ⚠ カレンダー / やることの板の同じ形の主張は **#292 段⑤ で落とした**
   *   (2026-08-23)── あの 2 つは「アプリ」ではなく**ノートの見方**だったので、
   *   タイルではなく**左の列のタブ**が導線になった(上の it が見ている)。
   * 🔑 タイルに残るのは、**幅が本当に要る** 2 ペインだけである。
   */
  it('🔴 2 ペインは組み込みタイルから開ける', async () => {
    const { dualTile, withBuiltinTiles, tileSelectsEntry } = await import(
      '@features/launcher/tiles'
    );
    const tiles = withBuiltinTiles([], { office: false });
    const dual = tiles.find((t) => t.kind === 'dual');
    expect(dual, 'アプリの一覧に 2 ペインが出ない').toBeDefined();
    // ⚠ 組み込みは entry を持たない(存在しない lid を選択に入れない)
    expect(tileSelectsEntry(dualTile())).toBe(false);
    /**
     * 🔴 **引っ越した 2 つは、もうタイルに居ない**(同じものが 2 か所に無い)。
     * ⚠ `manual`(#645)は**引っ越した面ではない** ── ノートの見方ではなく、
     *   閉じても失うのがマニュアルだけの「アプリ」である(`tiles.ts` の見分け方)。
     */
    expect(tiles.map((t) => t.kind), '引っ越した面がタイルに残っている').toEqual([
      'dual',
      'manual',
    ]);
  });

  /**
   * 🔴 **向きは 2 度裏返った。**(#277 段②-b で「復活させたので在るのが正しい」→
   * #292 段⑤ で「引っ越したので**別の file に在る**のが正しい」)。
   *
   * ⚠ 主張の向きを裏返したら作法も裏返る(CLAUDE.md §1)ので、
   *   **file の実在と `SEALED_TEST_NOTES` の文言を対で見る** ── 片方だけ直すと、
   *   次に読む人が「戻す先」を見失う。
   * 🔑 見るのは「引っ越し先が実在すること」である ── 元の file が無いことでは
   *   ない(そちらは `git` が知っている)。**引っ越し先が消えたら、規則を実際に
   *   駆動している物が 1 つも無くなる**、が守りたいことである。
   */
  it('🔴 引っ越した test の記録が実態と合っている(戻す先を失わない)', () => {
    for (const path of [
      'tests/smoke/schedule.smoke.spec.ts',
      'tests/adapter/schedule-view.test.ts',
      'tests/adapter/center-pane.test.ts',
    ]) {
      expect(() => readFileSync(path, 'utf-8'), `引っ越し先が消えている: ${path}`).not.toThrow();
    }
    expect(SEALED_TEST_NOTES, '記録が古い引っ越し先を指したままである').toContain(
      'tests/smoke/schedule.smoke.spec.ts',
    );
    // ⚠ 空振り防止 ── 記録が「畳んだ」の側に戻っていないこと
    expect(SEALED_TEST_NOTES, '封印へ戻したかのような記録になっている').toContain('引っ越し済み');
  });
});
