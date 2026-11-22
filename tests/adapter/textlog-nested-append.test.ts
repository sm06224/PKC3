/** @vitest-environment happy-dom */
/**
 * 🔴 **ログの追記先を選ぶと、その記録の中へ入る**(#2018 7。案 A。user 裁定 2026-11-22)。
 *
 * ⚠ 直す前は、追記先を選んでも常に `## 時刻` を足していた ── 選んだ記録の中ではなく、**並びの新しい記録**が
 *   選んだ節の途中に生えていた(`##` は `###` の節を切る)。
 * 🔑 仕様: 末尾(追記先なし)は今までどおり `## 時刻`。見出しを選んだら**その 1 段下**の時刻見出し
 *   (`##` → `###`、`###` → `####` … 上限 `######`)で、その節の末尾に入る。段は**書く直前の本文**から引く。
 *
 * 観測点は **disk に着いた本文**。
 */
import { stubStamps } from '../helpers/store-stamps';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryMeta } from '../../src/core/model/entry-meta';
import type { EntryUpsert } from '../../src/adapter/platform/storage/schema';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { connectStoreEffects } from '../../src/adapter/state/store-effects';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { AppendBoxRenderer } from '../../src/adapter/ui/render/append-box';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import { stubRevisionOps } from '../helpers/revision-stub';

const DOC = [
  '## 2026-11-20 09:00:00',
  '',
  '朝の記録',
  '',
  '### 2026-11-20 09:30:00',
  '',
  '追いログ',
  '',
  '###### 2026-11-20 09:40:00',
  '',
  '一番深い',
  '',
  '## 2026-11-21 10:00:00',
  '',
  '次の日',
  '',
].join('\n');

function meta(lid: string): EntryMeta {
  return {
    lid,
    title: 't-' + lid,
    archetype: 'textlog',
    createdAt: null,
    updatedAt: null,
    entryOrder: 1,
    status: null,
    date: null,
    archived: false,
    bodyChars: null,
  };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  document.body.textContent = '';
});

function setup(body = DOC, body2 = 'べつのノート\n') {
  const root = document.createElement('div');
  document.body.append(root);
  const d = new Dispatcher();
  const box = new AppendBoxRenderer(buildShell(root).append);
  d.onState((s) => box.render(s));
  bindActions(root, d);
  const persisted: EntryUpsert[] = [];
  const disk: Record<string, string> = { n1: body, n2: body2 };
  const failures: string[] = [];
  d.onState((s) => {
    if (s.error !== null && !failures.includes(s.error)) failures.push(s.error);
  });
  connectStoreEffects(d, {
    ...stubRevisionOps(),
    getBody: async (lid) => disk[lid] ?? null,
    deleteEntry: async () => {},
    setEntryParent: async () => {},
    renameEntry: async () => stubStamps(),
    replaceAssetRefs: () => Promise.reject(new Error('この test では使わない')),
    reorderEntry: async () => stubStamps(),
    persistEntry: async (e) => {
      persisted.push(e);
      disk[e.lid] = e.body;
      return stubStamps();
    },
  });
  d.dispatch({ type: 'SYS_BOOTED', cid: 'c1', metas: [meta('n1'), meta('n2')], relations: [] });
  const q = <T extends HTMLElement>(s: string): T | null => root.querySelector<T>(s);
  return { root, d, persisted, disk, failures, q };
}

async function open(s: ReturnType<typeof setup>): Promise<void> {
  s.d.dispatch({ type: 'SELECT_ENTRY', lid: 'n1' });
  await tick();
}

const sel = (s: ReturnType<typeof setup>): HTMLSelectElement =>
  s.q<HTMLSelectElement>('[data-pkc-field="append-target"]')!;

function send(s: ReturnType<typeof setup>, text: string): void {
  s.q<HTMLTextAreaElement>('[data-pkc-field="append-input"]')!.value = text;
  s.q('[data-pkc-action="append-entry"]')!.click();
}


const STAMP = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`;

/** `sel` の option から、字が `text` の見出しの印を引く。 */
function pick(s: ReturnType<typeof setup>, text: string): void {
  const o = [...sel(s).options].find((x) => x.textContent?.trim() === text);
  if (o === undefined) throw new Error(`追記先に「${text}」が無い`);
  sel(s).value = o.value;
}

describe('#2018 7 ログの入れ子の追記', () => {
  it('🔴 末尾(追記先なし)は今までどおり `## 時刻` の新しい記録', async () => {
    const s = setup();
    await open(s);
    send(s, '夜の記録');
    await tick();
    expect(s.failures).toEqual([]);
    expect(s.disk.n1).toMatch(new RegExp(`次の日\\n\\n## ${STAMP}\\n\\n夜の記録\\n$`));
  });

  it('🔴 `##` の記録を選ぶと、その記録の末尾(次の `##` の手前)に `### 時刻` で入る', async () => {
    const s = setup();
    await open(s);
    pick(s, '2026-11-20 09:00:00');
    send(s, '昼の追いログ');
    await tick();
    expect(s.failures).toEqual([]);
    const body = s.disk.n1!;
    // 並びの新しい `##` は生えない(直す前の症状)
    expect(body.match(/^## /gm)?.length, '並びの新しい記録が生えた').toBe(2);
    expect(body).toMatch(new RegExp(`一番深い\\n\\n### ${STAMP}\\n\\n昼の追いログ\\n\\n## 2026-11-21 10:00:00`));
  });

  it('🔴 `###` を選ぶと `####`、`######` を選ぶと `######` のまま(上限)', async () => {
    const s = setup();
    await open(s);
    pick(s, '2026-11-20 09:30:00');
    send(s, '三段目の下');
    await tick();
    expect(s.disk.n1).toMatch(new RegExp(`^#### ${STAMP}\\n\\n三段目の下$`, 'm'));
    pick(s, '2026-11-20 09:40:00');
    send(s, '上限の下');
    await tick();
    expect(s.failures).toEqual([]);
    expect(s.disk.n1).toMatch(new RegExp(`一番深い\\n\\n###### ${STAMP}\\n\\n上限の下`));
    expect(s.disk.n1).not.toMatch(/^#{7}/m);
  });

  it('🔴 段は書く直前の本文から引く(画面を開いた後に別の窓が段を変えていたら、そちらに従う)', async () => {
    const s = setup();
    await open(s);
    pick(s, '2026-11-20 09:00:00');
    // 画面は `##` のまま、disk だけ `###` に変わった(別のタブの書込)
    s.disk.n1 = s.disk.n1!.replace('## 2026-11-20 09:00:00', '### 2026-11-20 09:00:00');
    send(s, '読み直した段');
    await tick();
    expect(s.failures).toEqual([]);
    expect(s.disk.n1).toMatch(new RegExp(`^#### ${STAMP}\\n\\n読み直した段$`, 'm'));
  });
});
