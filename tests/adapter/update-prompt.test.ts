/** @vitest-environment node */
/**
 * P7 段⑤: 更新の届き方。
 *
 * 🔴 ここは「壊れても誰も気づかない」種類の機構である ── 更新は**滅多に来ない**ので、
 * 案内が出ない / 出っぱなし / 別タブを巻き込んで再読込する、のどれも
 * 手元の操作では踏まない。**stub を本物の形に合わせて**全経路を発火させる。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  watchForUpdate,
  type InstallingWorker,
  type UpdateContainer,
  type UpdateRegistration,
  type UpdateWorker,
} from '../../src/adapter/platform/sw/update-prompt';

/** `installing` の worker。⚠ 状態遷移は**イベントで**伝わる(本物と同じ)。 */
class FakeInstalling implements InstallingWorker {
  state = 'installing';
  readonly messages: unknown[] = [];
  private readonly listeners: Array<() => void> = [];
  postMessage(m: { type: 'SKIP_WAITING' }): void {
    this.messages.push(m);
  }
  addEventListener(_type: 'statechange', fn: () => void): void {
    this.listeners.push(fn);
  }
  /** 本物の遷移を真似る: state を進めてから statechange を投げる。 */
  advance(state: string): void {
    this.state = state;
    for (const fn of [...this.listeners]) fn();
  }
}

class FakeRegistration implements UpdateRegistration {
  waiting: UpdateWorker | null = null;
  installing: FakeInstalling | null = null;
  private readonly listeners: Array<() => void> = [];
  addEventListener(_type: 'updatefound', fn: () => void): void {
    this.listeners.push(fn);
  }
  /** 本物の順序を真似る: `installing` を差してから updatefound を投げる。 */
  found(worker: FakeInstalling): void {
    this.installing = worker;
    for (const fn of [...this.listeners]) fn();
  }
}

class FakeContainer implements UpdateContainer {
  controller: unknown = null;
  private readonly listeners: Array<() => void> = [];
  addEventListener(_type: 'controllerchange', fn: () => void): void {
    this.listeners.push(fn);
  }
  /** `clients.claim()` が起きた ── **全タブに**飛ぶ。 */
  controllerChanged(): void {
    this.controller = {};
    for (const fn of [...this.listeners]) fn();
  }
}

interface Harness {
  container: FakeContainer;
  registration: FakeRegistration;
  /** 案内が出た回数ぶんの「押す」関数。 */
  offers: Array<() => void>;
  reloads: () => number;
}

async function start(
  setup?: (c: FakeContainer, r: FakeRegistration) => void,
  registered?: Promise<UpdateRegistration | null>,
): Promise<Harness> {
  const container = new FakeContainer();
  const registration = new FakeRegistration();
  setup?.(container, registration);
  const offers: Array<() => void> = [];
  let reloads = 0;
  await watchForUpdate(
    container,
    registered ?? Promise.resolve(registration),
    (apply) => offers.push(apply),
    () => {
      reloads += 1;
    },
  );
  return { container, registration, offers, reloads: () => reloads };
}

describe('更新の案内 — いつ出すか', () => {
  it('🔴 初回インストールでは案内を出さない(初めて開いた人に更新は無い)', async () => {
    // ⚠ 初回でも `installed` は通る。`controller` を見ないと
    // 「初めて開いた人」に「新しい版があります」が出る
    const h = await start();
    const w = new FakeInstalling();
    h.registration.found(w);
    w.advance('installed'); // controller は null のまま(誰にも制御されていない)
    expect(h.offers).toHaveLength(0);
  });

  it('🔴 制御されているページで installed になったら案内を出す', async () => {
    const h = await start((c) => {
      c.controller = {}; // 既に旧 SW が制御している
    });
    const w = new FakeInstalling();
    h.registration.found(w);
    w.advance('installed');
    expect(h.offers).toHaveLength(1);
  });

  it('attach 前に待機まで進んでいても取り零さない', async () => {
    // 🔑 登録は boot を待たずに走るので、shell ができる頃には
    // `waiting` まで済んでいることがある
    const waiting: UpdateWorker = { postMessage: vi.fn() };
    const h = await start((c, r) => {
      c.controller = {};
      r.waiting = waiting;
    });
    expect(h.offers).toHaveLength(1);
  });

  it('attach 前に installing まで進んでいても取り零さない', async () => {
    // ⚠ `updatefound` は attach 前に飛び終わっている ── listener を張るだけでは
    // 届かないので、attach 時に**現況を見る**
    const w = new FakeInstalling();
    const h = await start((c, r) => {
      c.controller = {};
      r.installing = w;
    });
    expect(h.offers).toHaveLength(0); // まだ installing
    w.advance('installed');
    expect(h.offers).toHaveLength(1);
  });

  it('🔴 二度は出さない(updatefound は再検査のたびに来る)', async () => {
    const h = await start((c) => {
      c.controller = {};
    });
    const a = new FakeInstalling();
    h.registration.found(a);
    a.advance('installed');
    const b = new FakeInstalling();
    h.registration.found(b);
    b.advance('installed');
    expect(h.offers).toHaveLength(1);
  });

  it('登録が成立しない環境では何もしない(file:// の可搬 HTML)', async () => {
    const h = await start(undefined, Promise.resolve(null));
    h.container.controllerChanged();
    expect(h.offers).toHaveLength(0);
    expect(h.reloads()).toBe(0);
  });
});

describe('更新の適用 — 押したときだけ、押したタブだけ', () => {
  const offered = async (): Promise<{ h: Harness; worker: FakeInstalling }> => {
    const h = await start((c) => {
      c.controller = {};
    });
    const worker = new FakeInstalling();
    h.registration.found(worker);
    worker.advance('installed');
    return { h, worker };
  };

  it('押すと交代を頼む(SKIP_WAITING を待機中の worker へ送る)', async () => {
    const { h, worker } = await offered();
    h.offers[0]!();
    expect(worker.messages).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('🔴 押しただけでは再読込しない(交代が済んでから)', async () => {
    // ⚠ 先に reload すると、まだ旧 SW が制御しているので**同じ版が出る**
    const { h } = await offered();
    h.offers[0]!();
    expect(h.reloads()).toBe(0);
    h.container.controllerChanged();
    expect(h.reloads()).toBe(1);
  });

  it('🔴 押していないタブは再読込しない(別タブの下書きを巻き込まない)', async () => {
    // `clients.claim()` は**全タブ**に controllerchange を投げる。無条件に
    // 再読込すると、別タブで編集中の下書きが消える
    const { h } = await offered();
    h.container.controllerChanged();
    expect(h.reloads()).toBe(0);
  });

  it('🔴 再読込は 1 回だけ(controllerchange は複数回来うる)', async () => {
    const { h } = await offered();
    h.offers[0]!();
    h.container.controllerChanged();
    h.container.controllerChanged();
    expect(h.reloads()).toBe(1);
  });
});
