/** @vitest-environment happy-dom */
/**
 * 🔴 **書き出す file 名の「今日」は端末の暦日**(#709 案 A)。
 *
 * 直す前は 2 系統あった ── 設定(`export-settings`)と連絡先(`export-vcards`)は
 * `new Date().toISOString().slice(0, 10)`(= **UTC の暦日**)、バックアップと
 * 持ち歩ける 1 枚は端末の暦日。日本の 0 時〜9 時に押すと、**同じ朝に落とした
 * 2 つの file の日付が食い違い**、設定 / 連絡先のほうは前日の名前になっていた。
 *
 * 🔑 時計を `2026-08-04T23:30:00Z` に止め、TZ を切り替えて見る ──
 *   JST なら `2026-08-05`、UTC なら `2026-08-04`。⚠ 対照群(UTC 側)も同じ it に置く
 *   (「JST で 08-05 が出た」だけでは、時計も TZ も効いていない形を見抜けない)。
 * ⚠ 名前は `<a download>` の属性で見る(happy-dom / headless は非 ASCII の
 *   `suggestedFilename` を捨てる ── CLAUDE.md §4)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../../src/adapter/state/dispatcher';
import { buildShell } from '../../src/adapter/ui/render/shell';
import { bindActions } from '../../src/adapter/ui/actions/binder';
import type { ContactScan } from '../../src/features/contact/contact-card';

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** 押し口を 1 つ持つ root と、そこに繋いだ dispatcher。 */
function setup(action: string): { root: HTMLElement; d: Dispatcher; btn: HTMLElement } {
  document.body.innerHTML = '';
  localStorage.clear();
  const root = document.createElement('div');
  document.body.append(root);
  buildShell(root);
  // ⚠ 面の中身ではなく **binder の委譲**を見る ── 押し口は root の中なら何でも拾う
  const btn = document.createElement('button');
  btn.setAttribute('data-pkc-action', action);
  root.append(btn);
  const d = new Dispatcher();
  bindActions(root, d);
  return { root, d, btn };
}

const SCAN: ContactScan = {
  cards: [
    {
      lid: 'c1',
      name: '山田太郎',
      org: '',
      orgParts: [],
      tels: ['090-1234-5678'],
      emails: [],
      birthday: '',
      overlong: false,
    },
  ],
  totalNotes: 1,
  scannedNotes: 1,
  truncated: false,
};

/** `tz` に切り替え、時計を `at` に止めて `fn` を回す。必ず戻す。 */
async function at(tz: string, iso: string, fn: () => Promise<void>): Promise<void> {
  const before = process.env.TZ;
  process.env.TZ = tz;
  vi.useFakeTimers({ toFake: ['Date'] }); // ⚠ setTimeout は本物のまま(tick が要る)
  vi.setSystemTime(new Date(iso));
  try {
    await fn();
  } finally {
    vi.useRealTimers();
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

/** 落ちた file の名前を集める(`<a download>` の属性)。 */
function catchDownloads(): string[] {
  const names: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
    names.push(this.getAttribute('download') ?? '');
  });
  return names;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('書き出す file 名の「今日」(#709)', () => {
  it('⚠ 対照群 ── 時計と TZ の切り替えが効いている(効いていなければ以下は空振り)', async () => {
    await at('Asia/Tokyo', '2026-08-04T23:30:00Z', async () => {
      expect(new Date().getDate(), 'JST の 8/5 になっていない').toBe(5);
    });
    await at('UTC', '2026-08-04T23:30:00Z', async () => {
      expect(new Date().getDate(), 'UTC の 8/4 になっていない').toBe(4);
    });
  });

  it('🔴 設定の書き出し ── JST の朝は 08-05、UTC なら 08-04', async () => {
    for (const [tz, want] of [
      ['Asia/Tokyo', 'PKC3-settings-2026-08-05.json'],
      ['UTC', 'PKC3-settings-2026-08-04.json'],
    ] as const) {
      await at(tz, '2026-08-04T23:30:00Z', async () => {
        const { btn } = setup('export-settings');
        localStorage.setItem('pkc3.theme', 'dark'); // 持ち出せる設定を 1 つ作る
        const names = catchDownloads();
        btn.click();
        await tick();
        expect(names, `TZ=${tz}: 落ちていない`).toHaveLength(1);
        expect(names[0], `TZ=${tz}: 名前の日付が端末の暦日でない`).toBe(want);
        vi.restoreAllMocks();
      });
    }
  });

  it('🔴 連絡先の書き出し ── JST の朝は 08-05、UTC なら 08-04', async () => {
    for (const [tz, want] of [
      ['Asia/Tokyo', '連絡先-2026-08-05.vcf'],
      ['UTC', '連絡先-2026-08-04.vcf'],
    ] as const) {
      await at(tz, '2026-08-04T23:30:00Z', async () => {
        const { d, btn } = setup('export-vcards');
        d.dispatch({ type: 'SET_CONTACT_SCAN', scan: SCAN });
        const names = catchDownloads();
        btn.click();
        await tick();
        expect(names, `TZ=${tz}: 落ちていない`).toHaveLength(1);
        expect(names[0], `TZ=${tz}: 名前の日付が端末の暦日でない`).toBe(want);
        vi.restoreAllMocks();
      });
    }
  });
});
