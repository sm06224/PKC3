/**
 * React(JSX)の囲みの器を、**sandbox の箱**で埋める(#528 ②)。
 *
 * 型は他の図と同じ(`mermaid-hydrate.ts`): 器は placeholder(原文を属性に持つ)で、**見えたとき**に埋める。
 * ただし React は PNG に焼かない(操作できる画面を描く物)── **箱(iframe)を 1 つ**置く。
 *
 * 🔴 箱の中身はランタイム込みの HTML(`platform/render/react-frame-doc.ts`)。ランタイム(React・sucrase・Tailwind)は
 *   約 1 MB あるので、**この囲みが本文に在って、見えたときに初めて**遅延 import する(初期ロードにも、markdown の
 *   描画結果にも載せない)。箱の寿命は器の寿命:本文を離れて器が外れれば、箱ごと捨てる(`prune` / `dispose`)。
 * 🔑 高さは箱が申告する(` ```html ` の箱と同じ口 ── `installHtmlSandboxResizer`)。箱は
 *   `iframe[data-pkc-html-render-id]` なので、止めた要求の申告・高さの引き継ぎも同じ道に乗る。
 * ⚠ 失敗(ランタイムを読めない)は器に理由を残し、原文は器に残す(黙って空にしない)。
 */
import { restoreSandboxHeights } from '@features/markdown/html-sandbox';
import { errorMessageJa } from '@features/error-text';
import { reactFrameDoc } from '@adapter/platform/render/react-frame-doc';
import { watchVisible } from './visible-watch';
import { typingQuietIn } from './typing-gate';
import { registerLiveScope, type MermaidScope } from './mermaid-hydrate';

export const REACT_ATTR = 'data-pkc-react-src';

/** 箱の id を中身から決める(乱数にしない ── 差分反映が毎回作り直さない。`html-sandbox.ts` の `stableKey` と同じ考え方)。 */
function stableId(source: string, occurrence: number): string {
  let h = 0x811c9dc5;
  const text = `${source}\u0000${String(occurrence)}`;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `pkc-react-${h.toString(36).padStart(7, '0')}`;
}

/** ランタイムの字(遅延 import)。⚠ 失敗は覚えない(次の機会に読み直す)。 */
let runtimeP: Promise<{ runtime: string; tailwind: string }> | null = null;
export function loadReactRuntime(): Promise<{ runtime: string; tailwind: string }> {
  runtimeP ??= Promise.all([import('virtual:pkc3-react-runtime'), import('virtual:pkc3-tailwind')])
    .then(([r, t]) => ({ runtime: r.default, tailwind: t.default }))
    .catch((e: unknown) => {
      runtimeP = null;
      throw e;
    });
  return runtimeP;
}

/** test が差し替える口。 */
let loader: typeof loadReactRuntime | null = null;
export function setReactRuntimeLoader(fn: typeof loadReactRuntime | null): void {
  loader = fn;
}

export function hydrateReact(root: ParentNode | readonly ParentNode[]): MermaidScope {
  const roots: readonly ParentNode[] = Array.isArray(root) ? (root as readonly ParentNode[]) : [root as ParentNode];
  const hosts: HTMLElement[] = [];
  for (const r of roots) {
    if (r instanceof Element && r.matches(`[${REACT_ATTR}]`)) hosts.push(r as HTMLElement);
    hosts.push(...r.querySelectorAll<HTMLElement>(`[${REACT_ATTR}]`));
  }
  if (hosts.length === 0) return { dispose: () => undefined, prune: () => 0, flush: () => Promise.resolve() };

  let disposed = false;
  /** 器 → 置いた箱。 */
  const frames = new Map<HTMLElement, HTMLIFrameElement>();
  const started = new WeakSet<HTMLElement>();
  /** 器 → 箱の読み込みが済んだ合図(印刷が待つ)。⚠ 箱を置いた**時点**で聞き始める(後から聞くと、済んだ後の `load` を取りこぼして上限まで待つ)。 */
  const loaded = new Map<HTMLElement, Promise<void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const occurrences = new Map<string, number>();

  const place = async (host: HTMLElement): Promise<void> => {
    if (disposed || started.has(host) || !host.isConnected) return;
    started.add(host);
    const source = host.getAttribute(REACT_ATTR) ?? '';
    const n = occurrences.get(source) ?? 0;
    occurrences.set(source, n + 1);
    try {
      const { runtime, tailwind } = await (loader ?? loadReactRuntime)();
      if (disposed || !host.isConnected) return;
      const id = stableId(source, n);
      const doc = host.ownerDocument;
      const f = doc.createElement('iframe');
      f.className = 'pkc-html-render pkc-react-frame';
      f.setAttribute('data-pkc-html-render-id', id);
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.title = 'React の表示';
      f.style.cssText = 'width:100%;border:0;height:0;display:block;';
      f.srcdoc = reactFrameDoc(source, runtime, tailwind, id);
      host.append(f);
      frames.set(host, f);
      loaded.set(host, new Promise<void>((resolve) => f.addEventListener('load', () => setTimeout(resolve, 300), { once: true })));
      restoreSandboxHeights([f]);
      host.setAttribute('data-pkc-react-state', 'ready');
      host.removeAttribute('data-pkc-react-error');
    } catch (e) {
      started.delete(host);
      host.setAttribute('data-pkc-react-state', 'failed');
      const why = errorMessageJa(e instanceof Error ? e.message : String(e));
      host.setAttribute(
        'data-pkc-react-error',
        `React を描けません(${why.length > 100 ? `${why.slice(0, 99)}…` : why})`,
      );
    }
  };

  const io = typeof IntersectionObserver === 'function'
    ? watchVisible((host) => {
        // 🔑 打っている間は新しい箱を始めない(1 MB のランタイムを打鍵のたびに読み込ませない)
        const wait = typingQuietIn();
        if (wait > 0) {
          const t = setTimeout(() => {
            timers.delete(t);
            void place(host);
          }, wait);
          timers.add(t);
          return;
        }
        void place(host);
      })
    : null;
  for (const h of hosts) {
    if (io !== null) io.observe(h);
    else void place(h);
  }

  const dropGone = (): void => {
    for (const [host, f] of [...frames]) {
      if (host.isConnected) continue;
      f.remove();
      frames.delete(host);
      loaded.delete(host);
    }
  };

  return registerLiveScope({
    dispose() {
      disposed = true;
      io?.disconnect();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const f of frames.values()) f.remove();
      frames.clear();
      loaded.clear();
    },
    prune() {
      dropGone();
      return hosts.filter((h) => h.isConnected).length;
    },
    /** 印刷など:見えていない器の箱も作り、読み込みの終わりまで待つ。 */
    async flush(r: ParentNode) {
      const targets = hosts.filter((h) => r === (h as unknown as ParentNode) || r.contains(h));
      await Promise.all(targets.map((h) => place(h)));
      await Promise.all(
        targets.map((h) => {
          const done = loaded.get(h);
          if (!done) return Promise.resolve();
          // ⚠ 上限を置く(読み込みが済まない箱 1 つで、印刷を止めない)
          return Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
        }),
      );
    },
  });
}
