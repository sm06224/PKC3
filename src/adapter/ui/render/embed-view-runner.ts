/**
 * 🔴 **既製の表(` ```embed `)を作る口**(#1966 4-2)── `setEmbedViewRunner` に差す実体。
 *
 * 表の組み立て(期日の窓・並び・リンク)は `features/markdown/embed-view.ts` が持ち、ここは
 * **材料を集めて渡すだけ**:
 *
 * | 表 | 材料 |
 * |---|---|
 * | `open-tasks` | `taskScan`(予定表と同じ走査 ── 本文は worker から出さない)+ 週の始まり(予定表の設定)|
 * | `recent` | 主スレッドが持つノートの一覧(`entryMetas` の更新日時 ── worker を叩かない)|
 * | `smart` | スマートフォルダの本文の条件(`readSmartSpec`)→ `smartScan`(スマートフォルダの面と同じ 2 手)|
 *
 * ⚠ **集める前に書込の後ろへ並ぶ**(`settled`)── 保存した直後に集めて古い表を出さない(`sql embed` と同じ)。
 * ⚠ 時計は呼び側が渡す(`now`)── test で答えを固定できるように。
 */
import { isSmartEmpty, readSmartSpec, SMART_ARCHETYPE, smartQueryOf, type SmartQuery } from '@features/smart/smart-spec';
import { localDateOfMs } from '@features/schedule/schedule-notify';
import type { TaskScan } from '@features/schedule/task-cards';
import type { WeekStart } from '@features/schedule/week-start';
import type { SqlEmbedAnswer } from '@features/markdown/sql-embed';
import {
  findSmartFolder,
  openTasksAnswer,
  parseEmbedView,
  recentAnswer,
  smartAnswer,
  type TitleOf,
} from '@features/markdown/embed-view';
import type { EntryMeta } from '@core/model/entry-meta';
import type { EmbedViewRunner } from './sql-embed-hydrate';

export interface EmbedViewDeps {
  /** 書込が終わるのを待つ(`storeEffects.settled`)。 */
  settled(): Promise<void>;
  /** ノートの一覧(主スレッドの `entryMetas`)。⚠ system 領域のノートは入っていない。 */
  metas(): ReadonlyMap<string, EntryMeta>;
  taskScan?: () => Promise<TaskScan>;
  getBody(lid: string): Promise<string | null>;
  smartScan?: (lid: string, query: SmartQuery) => Promise<{ lids: string[]; total: number }>;
  weekStart(): WeekStart;
  now(): number;
}

const OLD_BUILD = 'このタブの PKC3 が古いままのため、表を作れません。再読み込みしてください';

export function createEmbedViewRunner(deps: EmbedViewDeps): EmbedViewRunner {
  return async (text: string): Promise<SqlEmbedAnswer> => {
    const parsed = parseEmbedView(text);
    if (!parsed.ok) throw new Error(parsed.why);
    await deps.settled();
    const metas = deps.metas();
    // ⚠ アーカイブしたノートは表に出さない(一覧の既定と同じ)。ゴミ箱・system は metas に居ない
    const titleOf: TitleOf = (lid) => {
      const m = metas.get(lid);
      if (m === undefined || m.archived) return null;
      return m.title.trim() === '' ? '(無題)' : m.title;
    };
    const spec = parsed.spec;
    switch (spec.view) {
      case 'open-tasks': {
        if (deps.taskScan === undefined) throw new Error(OLD_BUILD);
        const scan = await deps.taskScan();
        return openTasksAnswer({
          cards: scan.cards,
          titleOf,
          today: localDateOfMs(deps.now()),
          weekStart: deps.weekStart(),
          range: spec.range,
        });
      }
      case 'recent':
        return recentAnswer({ notes: [...metas.values()], titleOf, nowMs: deps.now(), days: spec.days });
      case 'smart': {
        const lid = findSmartFolder(
          [...metas.values()].sort((a, b) => a.entryOrder - b.entryOrder),
          spec.name,
          SMART_ARCHETYPE,
        );
        if (lid === null) throw new Error(`スマートフォルダ「${spec.name}」が見つかりません(題名を確かめてください)`);
        if (deps.smartScan === undefined) throw new Error(OLD_BUILD);
        const body = await deps.getBody(lid);
        if (body === null) throw new Error(`スマートフォルダ「${spec.name}」を読めませんでした`);
        const cond = readSmartSpec(body);
        // ⚠ 条件が空なら走査しない(スマートフォルダの面と同じ ── 空は何にも当たらない)
        if (isSmartEmpty(cond))
          throw new Error(`スマートフォルダ「${spec.name}」に条件がありません(スマートフォルダを開いて条件を選んでください)`);
        const out = await deps.smartScan(lid, smartQueryOf(cond, deps.now()));
        return smartAnswer({ lids: out.lids, titleOf, updatedOf: (l) => metas.get(l)?.updatedAt ?? null });
      }
    }
  };
}
