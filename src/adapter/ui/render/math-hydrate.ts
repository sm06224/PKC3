/**
 * 🔴 **数式の器を埋める**(#707。user 裁定 2026-09-06「入れる」)。
 *
 * `renderMarkdown` は器と**原文**だけを出す(features 層は DOM を触らない)。
 * ここがその器を見つけて、ワーカーに描かせて差し替える ── mermaid / chart と
 * **同じ骨組み**である(`mermaid-hydrate.ts`)。
 *
 * ## ⚠ `DiagramKind` に相乗りしなかった理由
 *
 * あちらは **PNG に焼く**ための機構である(`RasterKey` / IDB / ObjectURL の
 * 寿命管理 / テーマ・幅・dpr で焼き直す)。数式は**字**なので、
 * ①拡大しても崩れない(焼く理由が無い)②ObjectURL を持たない
 * ③幅で焼き直さない ── **4 つの規律のうち 3 つが空になる**。
 * 🔑 空の規律を継ぐと「使っていない機構が生きているように見える」ので、
 *   ここは別に持つ。⚠ 代わりに**共通の作法は写す**:
 *   器に原文を持たせる / 失敗しても原文を残す / 成功したときだけ中身を捨てる。
 *
 * ## 失敗したときに何が見えるか
 *
 * ⚠ **白紙にしない。** ワーカーが立たない・KaTeX が読めない・式が壊れている ──
 * どれでも**打った字がそのまま残る**(いまの画面と 1 文字も変わらない)。
 * 理由は `data-pkc-math-error` に載せる(押し所ではないので画面には出さない)。
 */
import { WorkerLease } from '../../platform/worker-lease';
import type { MathJob, MathResult } from '../../platform/render/math-worker';

/** 1 度に画面へ流し込む数(⚠ 1000 式を一息で入れると長い仕事になる)。 */
const APPLY_CHUNK = 24;

export interface MathScope {
  /** 面を畳むときに呼ぶ ── 途中の流し込みを止める。 */
  dispose(): void;
  /**
   * まだ**結果が要る**器の数(0 なら呼び側が畳んでよい)。
   *
   * ⚠ mermaid の `prune()` は「ObjectURL を返す相手が残っているか」を数えるが、
   *   数式は URL を持たない ── ここが数えるのは
   *   **①流し込みがまだ終わっていない ②器が DOM に残っている**の 2 つである。
   * 🔑 形だけ合わせた `return 0` にしない ── そうすると `pruneScopes` が
   *   **描き終わる前に畳んで**、結果が捨てられる(いちばん気づけない形)。
   */
  prune(): number;
}

const NOOP: MathScope = { dispose: () => undefined, prune: () => 0 };

let lease: WorkerLease | null = null;
let spawn: (() => Worker) | null = null;

/**
 * ワーカーの作り方を差し替える口(test / 計測が使う)。
 * ⚠ 差し替えたら**前のものを捨てる** ── 残すと古いワーカーが生きたままになる。
 */
export function setMathWorkerSpawn(fn: (() => Worker) | null): void {
  lease?.dispose();
  lease = null;
  spawn = fn;
}

function leaseOf(): WorkerLease {
  lease ??= new WorkerLease({
    name: 'math',
    // ⚠ ここで作らない(遅延起動)── 数式の無いノートではワーカーが立たない
    spawn:
      spawn ??
      (() =>
        new Worker(new URL('../../platform/render/math-worker.ts', import.meta.url), {
          type: 'module',
        })),
  });
  return lease;
}

/** 空き時間に 1 回だけ呼ぶ(無い環境では次の tick)。 */
function onIdle(fn: () => void): void {
  const w = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(fn, { timeout: 400 });
  else setTimeout(fn, 0);
}

/**
 * 器を数え上げる。
 * ⚠ **根そのものが器のこともある**(`querySelectorAll` は自分を含まない)──
 *   差分反映は「新しく入った要素」を直に渡してくる。
 * ⚠ **済んだ物は拾わない** ── 拾うと、面を描き直すたびに全部描き直す。
 */
function hostsIn(root: ParentNode | readonly ParentNode[]): HTMLElement[] {
  const roots: readonly ParentNode[] = Array.isArray(root)
    ? (root as readonly ParentNode[])
    : [root as ParentNode];
  const sel = '[data-pkc-math-src]:not([data-pkc-math-state])';
  const out: HTMLElement[] = [];
  for (const r of roots) {
    if (r instanceof Element && r.matches(sel)) out.push(r as HTMLElement);
    out.push(...r.querySelectorAll<HTMLElement>(sel));
  }
  return out;
}

export function hydrateMath(root: ParentNode | readonly ParentNode[]): MathScope {
  const hosts = hostsIn(root);
  if (hosts.length === 0) return NOOP;

  let alive = true;
  /** 流し込みまで終わったか(⚠ `prune()` が早く 0 を返さないための印)。 */
  let done = false;
  const items = hosts.map((h) => ({
    tex: h.getAttribute('data-pkc-math-src') ?? '',
    display: h.getAttribute('data-pkc-math-display') === '1',
  }));

  /** ⚠ 失敗の印は**その場で**付ける(次の描き直しで無限に試させない)。 */
  const markFailed = (why: string): void => {
    for (const h of hosts) {
      h.setAttribute('data-pkc-math-state', 'failed');
      h.setAttribute('data-pkc-math-error', why.slice(0, 120));
    }
    done = true;
  };

  void leaseOf()
    .run<MathResult[]>({ items } satisfies MathJob)
    .then((results) => {
      if (!alive) return;
      let i = 0;
      const step = (): void => {
        if (!alive) return;
        const end = Math.min(i + APPLY_CHUNK, hosts.length);
        for (; i < end; i++) {
          const host = hosts[i]!;
          const r = results[i];
          if (r === undefined || !r.ok) {
            // ⚠ **原文はそのまま**(中身を捨てるのは成功したときだけ)
            host.setAttribute('data-pkc-math-state', 'failed');
            host.setAttribute('data-pkc-math-error', (r?.ok === false ? r.error : '結果が無い').slice(0, 120));
            continue;
          }
          host.innerHTML = r.html;
          host.setAttribute('data-pkc-math-state', 'done');
        }
        if (i < hosts.length) onIdle(step);
        else done = true;
      };
      step();
    })
    .catch((e: unknown) => {
      if (alive) markFailed(String(e));
    });

  return {
    dispose: () => {
      alive = false;
    },
    prune: () => {
      if (done) return 0;
      // ⚠ 器が全部 DOM から外れていたら、結果はもう要らない
      return hosts.some((h) => h.isConnected) ? hosts.length : 0;
    },
  };
}
