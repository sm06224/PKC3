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

  it('🔴 描画器と整形関数が生きている(解くときに書き直しにならない)', async () => {
    // import が通ること自体が観測点 ── 消されていれば解決に失敗して落ちる
    const [kanbanUi, calendarUi, kanbanData, calendarData] = await Promise.all([
      import('@adapter/ui/render/kanban'),
      import('@adapter/ui/render/calendar'),
      import('@features/kanban/kanban-data'),
      import('@features/calendar/calendar-data'),
    ]);
    expect(typeof kanbanUi.KanbanRenderer).toBe('function');
    expect(typeof calendarUi.CalendarRenderer).toBe('function');
    expect(typeof kanbanData.groupTasksByStatus).toBe('function');
    expect(typeof calendarData.groupEntriesByDate).toBe('function');
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
   * 🔴 **解いたカレンダーには、実際に開ける導線が在る**(#276)。
   *
   * ⚠ 封印を解くのが「配列から 1 語消す」だけで終わっていないことを見る ──
   *   `sealed.ts` はまさにそこ(消しても戻らない)を戒めている。
   * 🔑 観測点は**組み込みタイル**(#241 で確立した形)── 上の帯の切替ではない。
   */
  it('🔴 カレンダーは組み込みタイルから開ける(封印を解いただけで終わっていない)', async () => {
    const { calendarTile, withBuiltinTiles, tileSelectsEntry } = await import(
      '@features/launcher/tiles'
    );
    expect(isSealedView('calendar'), 'カレンダーがまだ封印されている').toBe(false);
    const tiles = withBuiltinTiles([], { office: false });
    const cal = tiles.find((t) => t.kind === 'calendar');
    expect(cal, 'アプリの一覧にカレンダーが出ない(解いただけで導線が無い)').toBeDefined();
    expect(cal?.title).toBe('カレンダー');
    // ⚠ 組み込みは entry を持たない(存在しない lid を選択に入れない)
    expect(tileSelectsEntry(calendarTile())).toBe(false);
  });

  /**
   * 🔴 **カンバンは組み込みタイルから開ける**(#277 段②-b。カレンダーと同じ形)。
   * ⚠ 「封印を解く = 配列から 1 語消す」で終わっていないことを見る。
   */
  it('🔴 カンバンは組み込みタイルから開ける(封印を解いただけで終わっていない)', async () => {
    const { kanbanTile, withBuiltinTiles, tileSelectsEntry } = await import(
      '@features/launcher/tiles'
    );
    expect(isSealedView('kanban'), 'カンバンがまだ封印されている').toBe(false);
    const tiles = withBuiltinTiles([], { office: false });
    const board = tiles.find((t) => t.kind === 'kanban');
    expect(board, 'アプリの一覧にカンバンが出ない(解いただけで導線が無い)').toBeDefined();
    // ⚠ 組み込みは entry を持たない(存在しない lid を選択に入れない)
    expect(tileSelectsEntry(kanbanTile())).toBe(false);
  });

  it('🔴 畳んだ smoke の記録が実態と合っている(戻す先を失わない)', () => {
    /**
     * 🔴 **向きが 2026-08-19 に裏返った**(#277 段②-b)── kanban smoke は
     * 復活させたので、**在るのが正しい**。
     * ⚠ 主張の向きを裏返したら作法も裏返る(CLAUDE.md §1)ので、
     *   `SEALED_TEST_NOTES` の文言も一緒に見る ── file だけ戻して記録が
     *   「削除した」のままだと、次に読む人が**もう一度消す**。
     */
    expect(() => readFileSync('tests/smoke/kanban.smoke.spec.ts', 'utf-8')).not.toThrow();
    expect(SEALED_TEST_NOTES, '記録が「削除した」のままである').toContain('復活済み');
    // dispatch 経由で描画を見ている test も在ること(中身の検証が消えていない)
    expect(() => readFileSync('tests/adapter/kanban-calendar-view.test.ts', 'utf-8')).not.toThrow();
  });
});
