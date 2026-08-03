/**
 * 描いた markdown の中の mermaid の器を、**PNG の `<img>` 1 枚**で埋める(P8 段③)。
 *
 * `markdown-render.ts` は fence を
 * `<div class="pkc-mermaid-placeholder" data-pkc-mermaid-src="...">` に変換する
 * ところまでやっており、**それを埋める側が PKC3 に存在しなかった**
 * (コメントだけが「adapter 層の hydrateMermaidPlaceholders が描く」と言っていた)。
 *
 * 方針(user 指示 2026-08-03):
 * - **描くのは見えたとき**(`IntersectionObserver`)── 20 枚あっても画面の分だけ
 * - **追従が悪ければ先読み**する ── 空き時間(`requestIdleCallback`)に同じ文書の
 *   残りを 1 枚ずつ。⚠ **入力が来たら止める**(先読みで打鍵が重くなったら本末転倒)
 * - **同じ図は焼き直さない** ── 鍵(原文 + テーマ + 幅 + dpr)が一致すれば IDB から
 * - **ObjectURL は要素の寿命終端で revoke**(2026-07-27 の不可侵指示)
 */
import { renderToPng } from './mermaid-raster';

/** 1 つの器を埋めるのに要る情報。 */
interface Pending {
  host: HTMLElement;
  source: string;
}

/**
 * 図を保存する導線(P8 段⑦)。
 *
 * > user 指示 2026-08-03「**mermaid 図のエクスポートをさせるとき以外は PNG ラスタを
 * > キャッシュして…**」── つまり**書き出しの導線が在る**前提の指示だったが、
 * > `renderToSvg()` は書かれたまま**呼び出し元が 0 件**だった(死んだコード)。
 *
 * ⚠ 器の中に置く ── 原文(`data-pkc-mermaid-src`)は器が持っているので、
 * binder は `closest` 1 回で「どの図か」に届く(押した所に原文を焼き込まない:
 * 大きい図の原文を属性で二重に持つことになる)。
 * ⚠ 図案だけのボタンにしない(段④ の規約)。地は無彩色・普段は控えめで、
 * hover / focus で立つ ── 「同じものが常に同じ場所にある」ので消しはしない。
 */
function saveButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-pkc-action', 'export-diagram');
  btn.setAttribute('data-pkc-field', 'diagram-save');
  const icon = document.createElement('span');
  icon.setAttribute('data-pkc-icon', '');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '⬇';
  const label = document.createElement('span');
  label.setAttribute('data-pkc-field', 'label');
  label.textContent = '図を保存';
  btn.append(icon, label);
  return btn;
}

function themeOf(): string {
  return document.documentElement.getAttribute('data-pkc-theme') ?? 'light';
}

/** 幅は 16px 刻みに丸める ── 端数で鍵が散ると毎回焼き直しになる。 */
function widthOf(host: HTMLElement): number {
  const w = host.clientWidth || host.parentElement?.clientWidth || 640;
  return Math.max(160, Math.round(w / 16) * 16);
}

/**
 * `root` の中の mermaid の器を埋める。
 *
 * @returns 後始末(ObserverIdle の解除 + ObjectURL の revoke)。
 *   ⚠ **必ず呼ぶ** ── 呼ばないと焼いた PNG の URL が生き残る。
 */
export function hydrateMermaid(root: ParentNode): () => void {
  const hosts = [...root.querySelectorAll<HTMLElement>('[data-pkc-mermaid-src]')];
  if (hosts.length === 0) return () => undefined;

  const urls: string[] = [];
  let disposed = false;
  let idle = 0;
  const queue: Pending[] = [];
  const done = new WeakSet<HTMLElement>();

  const paint = async (p: Pending): Promise<void> => {
    if (disposed || done.has(p.host)) return;
    done.add(p.host);
    try {
      const png = await renderToPng({
        source: p.source,
        theme: themeOf(),
        width: widthOf(p.host),
        dpr: window.devicePixelRatio || 1,
      });
      if (disposed) return;
      const url = URL.createObjectURL(png);
      urls.push(url);
      const img = document.createElement('img');
      img.setAttribute('data-pkc-field', 'mermaid-image');
      img.alt = '図';
      img.decoding = 'async';
      img.src = url;
      // ⚠ 焼いた実寸ではなく**器の幅**で出す(dpr 倍で焼いているので縮む = 鮮明)
      img.style.width = '100%';
      img.style.height = 'auto';
      p.host.textContent = '';
      p.host.append(img, saveButton());
      p.host.setAttribute('data-pkc-mermaid-state', 'ready');
    } catch (e) {
      // ⚠ 失敗しても**原文は残す**(器の中の `<pre>` を消すのは成功したときだけ)
      p.host.setAttribute('data-pkc-mermaid-state', 'failed');
      p.host.setAttribute('data-pkc-mermaid-error', String(e).slice(0, 120));
    }
  };

  // 🔑 見えたら描く
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const host = e.target as HTMLElement;
      io.unobserve(host);
      const source = host.getAttribute('data-pkc-mermaid-src') ?? '';
      void paint({ host, source });
    }
  });
  for (const host of hosts) {
    io.observe(host);
    queue.push({ host, source: host.getAttribute('data-pkc-mermaid-src') ?? '' });
  }

  /**
   * 🔑 **先読み**(user 指示「スクロール追従が悪いなら…あらかじめ」)。
   * 空き時間に 1 枚ずつ。⚠ 1 枚ごとに空き時間を取り直す ── まとめて回すと
   * そのフレームで打鍵が詰まる。
   */
  const ric: typeof requestIdleCallback | undefined =
    typeof requestIdleCallback === 'function' ? requestIdleCallback : undefined;
  const step = (): void => {
    idle = 0;
    if (disposed) return;
    const next = queue.shift();
    if (!next) return;
    void paint(next).then(() => {
      if (!disposed && queue.length > 0) idle = ric ? ric(step, { timeout: 2000 }) : 0;
    });
  };
  if (ric) idle = ric(step, { timeout: 2000 });

  return () => {
    disposed = true;
    io.disconnect();
    if (idle !== 0 && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
    // ⚠ **表示の寿命終端で捨てる**(生成物を残さない)
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  };
}
