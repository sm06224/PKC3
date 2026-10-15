/** @vitest-environment happy-dom */
/**
 * 🔴 「予定を .ics で書き出す」(#855 段 D)── 押したときに**いま予定の面が出している分だけ**が落ちる。
 *
 * 守る主張:
 * 1. 本物の道(押し口 → binder → `scheduleItemsOf` → `buildIcs` → 落とす)で、file 名が
 *    `pkc-schedule-<端末の暦日>.ics`、中身が `BEGIN:VCALENDAR` で始まる
 * 2. 🔴 面と同じ絞り(済んだ行は既定で隠す / 「出すもの」で出すと入る / 片付けたノートは既定で隠す)が効く
 *    ── 面の描画と書き出しが同じ口(`scheduleItemsOf`)を呼ぶことの pin
 * 3. 0 件なら file を落とさず、理由を言う
 * 4. 済ませた回(実体の行)は繰り返しの規則から EXDATE で外れる
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { taskCardsOf } from '../../src/features/schedule/task-cards';
import type { EntryMeta } from '../../src/core/model/entry-meta';

const meta = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  lid: 'a',
  title: '週次メモ',
  archetype: 'text',
  createdAt: null,
  updatedAt: null,
  entryOrder: 1,
  status: null,
  date: null,
  archived: false,
  bodyChars: null,
  ...over,
});

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

interface Rig {
  readonly d: Dispatcher;
  readonly press: () => Promise<{ names: string[]; blobs: Blob[] }>;
}

function rig(bodies: Record<string, string>, metas: EntryMeta[], truncated = false): Rig {
  document.body.innerHTML = '';
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', 'export-schedule-ics');
  root.append(btn);
  const d = new Dispatcher();
  bindActions(root, d);
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas, relations: [] });
  d.dispatch({ type: 'REFRESH_TASK_SCAN' });
  d.dispatch({
    type: 'SET_TASK_SCAN',
    scan: {
      cards: Object.entries(bodies).flatMap(([lid, body]) => taskCardsOf(lid, body)),
      totalNotes: metas.length,
      scannedNotes: metas.length,
      truncated,
    },
  });
  return {
    d,
    press: async () => {
      const names: string[] = [];
      const blobs: Blob[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
        names.push(this.getAttribute('download') ?? '');
      });
      URL.createObjectURL = ((b: Blob) => {
        blobs.push(b);
        return 'blob:x';
      }) as typeof URL.createObjectURL;
      URL.revokeObjectURL = (): void => undefined;
      btn.click();
      await tick();
      return { names, blobs };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('予定を .ics で書き出す', () => {
  it('🔴 file 名は端末の暦日、中身は VCALENDAR。行の予定と、載っているノートの題名が入る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 11, 12, 0, 0));
    const r = rig({ a: '- [ ] 見積を送る @2026-10-20 14:00..15:00\n' }, [meta()]);
    const out = await r.press();
    expect(out.names).toEqual(['pkc-schedule-2026-10-11.ics']);
    const text = await out.blobs[0]!.text();
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('SUMMARY:見積を送る\r\n');
    expect(text).toContain('DESCRIPTION:ノート: 週次メモ\r\n');
    expect(r.d.getState().notice).toContain('1 件');
  });

  it('🔴 走査が上限で切れていたら、「多いので途中まで集めた分です」と言う / 切れていなければ言わない(#1087)', async () => {
    const full = rig({ a: '- [ ] 見積 @2026-10-20\n' }, [meta()], false);
    await full.press();
    expect(full.d.getState().notice).not.toContain('途中まで');
    vi.restoreAllMocks();
    const cut = rig({ a: '- [ ] 見積 @2026-10-20\n' }, [meta()], true);
    await cut.press();
    expect(cut.d.getState().notice).toContain('(多いので途中まで集めた分です)');
    expect(cut.d.getState().notice).toContain('1 件');
  });

  it('🔴 済んだ行は既定で隠れている ── 面と同じく書き出しにも入らず、「出すもの」で出すと入る', async () => {
    const r = rig(
      { a: '- [ ] 未了 @2026-10-20\n- [x] 済み @2026-10-21\n' },
      [meta()],
    );
    const first = await r.press();
    const t1 = await first.blobs[0]!.text();
    expect(t1).toContain('SUMMARY:未了');
    expect(t1).not.toContain('SUMMARY:済み');
    vi.restoreAllMocks();
    r.d.dispatch({ type: 'TOGGLE_SHOW_DONE_TASKS' });
    const second = await r.press();
    const t2 = await second.blobs[0]!.text();
    expect(t2).toContain('SUMMARY:未了');
    expect(t2).toContain('SUMMARY:済み');
  });

  it('片付けたノートの予定は既定で入らない / 日付のない行は入らない', async () => {
    const r = rig(
      { a: '- [ ] 日付なし\n- [ ] 日付あり @2026-10-20\n', b: '- [ ] 片付けた @2026-10-22\n' },
      [meta(), meta({ lid: 'b', title: '古い', archived: true })],
    );
    const out = await r.press();
    const t = await out.blobs[0]!.text();
    expect(t).toContain('SUMMARY:日付あり');
    expect(t).not.toContain('日付なし');
    expect(t).not.toContain('片付けた');
  });

  it('🔴 済ませた回は繰り返しの規則から外れる(EXDATE)', async () => {
    const r = rig(
      { a: '- [ ] ゴミ出し @2026-10-05 毎週\n- [x] ゴミ出し @2026-10-12\n' },
      [meta()],
    );
    r.d.dispatch({ type: 'TOGGLE_SHOW_DONE_TASKS' });
    const out = await r.press();
    const t = await out.blobs[0]!.text();
    expect(t).toContain('RRULE:FREQ=WEEKLY\r\n');
    expect(t).toContain('EXDATE;VALUE=DATE:20261012\r\n');
  });

  it('0 件なら file を落とさず、理由を言う', async () => {
    const r = rig({ a: '- [ ] 日付なし\n' }, [meta()]);
    const out = await r.press();
    expect(out.names).toEqual([]);
    expect(r.d.getState().error).toContain('書き出せる予定がありません');
  });

  it('🔴 済んだ行が既定で隠れていても(出すものを触らなくても)、済ませた回は EXDATE で外れる', async () => {
    const r = rig(
      { a: '- [ ] ゴミ出し @2026-10-05 毎週\n- [x] ゴミ出し @2026-10-12\n' },
      [meta()],
    );
    expect(r.d.getState().showDoneTasks).toBe(false);
    const out = await r.press();
    const t = await out.blobs[0]!.text();
    expect(t).toContain('EXDATE;VALUE=DATE:20261012\r\n');
  });

  it('🔴 ノート丸ごとの予定(frontmatter の date:)も同じ絞りに従う ── 片付けた・検索で外れたものは入らない', async () => {
    const metas = [
      meta({ lid: 'n1', title: '出張', date: '2026-10-20' }),
      meta({ lid: 'n2', title: '片付けた出張', date: '2026-10-21', archived: true }),
      meta({ lid: 'n3', title: '会食', date: '2026-10-22' }),
    ];
    const r = rig({}, metas);
    const first = await (await r.press()).blobs[0]!.text();
    expect(first).toContain('SUMMARY:出張');
    expect(first).toContain('SUMMARY:会食');
    expect(first).not.toContain('片付けた出張');
    // note 丸ごとの予定は DESCRIPTION を持たない
    expect(first).not.toContain('DESCRIPTION');
    vi.restoreAllMocks();
    r.d.dispatch({ type: 'SET_ENTRY_FILTER', query: '会食' });
    const second = await (await r.press()).blobs[0]!.text();
    expect(second).toContain('SUMMARY:会食');
    expect(second).not.toContain('SUMMARY:出張');
  });

  it('🔴 書けた予定が 0 件で、読めない日付や時刻のせいなら、そう言う(「出ていません」とは別の文)', async () => {
    const r = rig({ a: '- [ ] 変な日 @2026-02-30\n- [ ] 変な時刻 @2026-10-20 25:99\n' }, [meta()]);
    const out = await r.press();
    expect(out.names).toEqual([]);
    const err = r.d.getState().error ?? '';
    expect(err).toContain('日付や時刻が読めない予定が 2 件あります');
    expect(err).not.toContain('いま一覧に出ていません');
  });

  it('🔴 端末の時刻帯の差が、実際の道具(getTimezoneOffset)から正しい向きで入る', async () => {
    const before = process.env.TZ;
    try {
      for (const [tz, want] of [
        ['Asia/Seoul', 'DTSTART:20261020T050000Z'], // 14:00 +09:00
        ['America/Los_Angeles', 'DTSTART:20261020T210000Z'], // 14:00 -07:00(10 月は夏時間)
        ['Asia/Tokyo', 'DTSTART;TZID=Asia/Tokyo:20261020T140000'],
      ] as const) {
        process.env.TZ = tz;
        const r = rig({ a: '- [ ] 会議 @2026-10-20 14:00\n' }, [meta()]);
        const text = await (await r.press()).blobs[0]!.text();
        expect(text, `TZ=${tz}`).toContain(`${want}\r\n`);
        vi.restoreAllMocks();
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});
