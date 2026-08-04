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
import { renderToPng, readPalette } from './mermaid-raster';

/** 1 つの器を埋めるのに要る情報。 */
interface Pending {
  host: HTMLElement;
  source: string;
}

/**
 * 配色が変わったら教える口(P8 段⑬)。
 *
 * 🔴 **観測器は全体で 1 つ**。`hydrateMermaid` は差分反映のたびに呼ばれる
 * (塊の数だけ)ので、呼ぶたびに `MutationObserver` を作ると観測器が積もる ──
 * 段⑪ で `IntersectionObserver` を 121 個作っていたのと同じ失敗になる。
 */
const themeWatchers = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function watchTheme(cb: () => void): () => void {
  themeWatchers.add(cb);
  if (themeObserver === null && typeof MutationObserver === 'function') {
    themeObserver = new MutationObserver(() => {
      for (const w of [...themeWatchers]) w();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-pkc-theme'],
    });
  }
  return () => {
    themeWatchers.delete(cb);
    // ⚠ 誰も見ていないなら止める(表示を畳んだ後も回り続けない)
    if (themeWatchers.size === 0) {
      themeObserver?.disconnect();
      themeObserver = null;
    }
  };
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

/**
 * 焼くときの**使える幅**(CSS px)。幅は 16px 刻みに丸める
 * ── 端数で鍵が散ると毎回焼き直しになる。
 *
 * 🔴 **器ではなく親を測る**(P8 段⑱ の変異試験で判明)。器
 * (`[data-pkc-mermaid-src]`)は段⑱ で `display: table` にした ── 中身に合わせて
 * 縮むので、**画像を入れる前の器の幅は `min-width` そのもの**(112px)である。
 * そこを測ると、どんなに大きな図でも常に 160px で焼くことになり、
 * 大きい図が潰れて読めなくなる。使える幅を知っているのは**親**の側。
 */
function widthOf(host: HTMLElement): number {
  const w = host.parentElement?.clientWidth || host.clientWidth || 640;
  return Math.max(160, Math.round(w / 16) * 16);
}

/**
 * `root` の中の mermaid の器を埋める。
 *
 * @returns この塊の面倒を見る口。⚠ **必ず `dispose()` する** ── 呼ばないと
 *   焼いた PNG の URL が生き残る。
 *   ⚠ 差分反映で器が差し替わる面では、新しい塊を作る前に `prune()` を呼ぶ
 *   ── 返り値が 0 なら、その塊はもう畳んでよい。
 */
export interface MermaidScope {
  /** 全部畳む(URL の revoke と観測の解除)。 */
  dispose(): void;
  /**
   * DOM から外れた器のぶんだけ畳んで、**まだ画面に居る器の数**を返す。
   *
   * 🔴 これが無いと、編集プレビューのように**器を差し替えながら何度も呼ぶ**面で
   * 塊が積もる(P8 段⑰。レビュー H-5)── 実測: 器を差し替えて 5 回呼ぶと
   * `createObjectURL` 5 回 / `revokeObjectURL` 0 回で、画面に無い PNG の URL が
   * 4 本生きたままだった。
   */
  prune(): number;
}

export function hydrateMermaid(root: ParentNode | readonly ParentNode[]): MermaidScope {
  // ⚠ **複数の根をまとめて受ける**(P8 段⑪)── 差分反映は「新しく入った要素」を
  // 何個も渡してくるので、1 個ずつ呼ぶと **要素の数だけ観測器ができる**
  // (121 個の IntersectionObserver、121 個の idle ループ)。
  // ⚠ 根そのものが器である場合も拾う(`querySelectorAll` は自分を含まない)
  const roots: readonly ParentNode[] = Array.isArray(root)
    ? (root as readonly ParentNode[])
    : [root as ParentNode];
  const hosts: HTMLElement[] = [];
  for (const r of roots) {
    if (r instanceof Element && r.matches('[data-pkc-mermaid-src]')) hosts.push(r as HTMLElement);
    hosts.push(...r.querySelectorAll<HTMLElement>('[data-pkc-mermaid-src]'));
  }
  if (hosts.length === 0) return { dispose: () => undefined, prune: () => 0 };

  /** 器 → いま貸している ObjectURL。**焼き直したら前のを返す**。 */
  const urlOf = new Map<HTMLElement, string>();
  let disposed = false;
  let idle = 0;
  const queue: Pending[] = [];
  const done = new WeakSet<HTMLElement>();
  /** 焼き**始めた**器(配色を変えたときの対象。`urlOf` は焼き終わったものだけ)。 */
  const started = new Set<HTMLElement>();

  /**
   * 焼き直しの世代(P8 段⑰。レビュー H-8 / M)。
   * 🔴 配色を続けて変えると、**最後に解決した**古い配色の絵が残る ── 焼くのは
   * 非同期なので、後から始まった方が先に終わりうる。世代が古い結果は捨てる。
   */
  let gen = 0;

  const paint = async (p: Pending, force = false): Promise<void> => {
    if (disposed) return;
    // ⚠ **画面から外れた器には描かない**(差し替え済みの器を先読み列が
    //    焼き続けていた ── 配色経路 と規則を 1 つに寄せる)
    if (!p.host.isConnected) return;
    if (!force && done.has(p.host)) return;
    done.add(p.host);
    started.add(p.host);
    const at = gen;
    try {
      const raster = await renderToPng({
        source: p.source,
        theme: themeOf(),
        palette: readPalette(),
        width: widthOf(p.host),
        dpr: window.devicePixelRatio || 1,
      });
      if (disposed) return;
      // ⚠ 焼いている間に配色が変わった / 器が外れたなら**載せない**
      //    (載せると古い配色の絵が最後に勝つ)
      if (at !== gen || !p.host.isConnected) return;
      const url = URL.createObjectURL(raster.png);
      const img = document.createElement('img');
      img.setAttribute('data-pkc-field', 'mermaid-image');
      img.alt = '図';
      img.decoding = 'async';
      img.src = url;
      // ⚠ 焼いた実寸ではなく**CSS 幅**で出す(dpr 倍で焼いているので縮む = 鮮明)。
      // 🔴 器いっぱいに引き伸ばさない(P8 段⑱)── 2 節点の図が 875×1286px を
      //    占めていた。`cssWidth` は SVG の自然幅で頭打ちにした値
      img.style.width = `${raster.cssWidth}px`;
      img.style.maxWidth = '100%';
      img.style.height = 'auto';
      p.host.textContent = '';
      p.host.append(img, saveButton());
      p.host.setAttribute('data-pkc-mermaid-state', 'ready');
      // ⚠ **差し替えてから**前の URL を捨てる(生成物の寿命終端 ── 不可侵指示)
      const prev = urlOf.get(p.host);
      urlOf.set(p.host, url);
      if (prev !== undefined) URL.revokeObjectURL(prev);
    } catch (e) {
      // ⚠ 失敗しても**原文は残す**(器の中の `<pre>` を消すのは成功したときだけ)
      p.host.setAttribute('data-pkc-mermaid-state', 'failed');
      p.host.setAttribute('data-pkc-mermaid-error', String(e).slice(0, 120));
    }
  };

  /**
   * 🔑 **配色を変えたら焼き直す**(P8 段⑬)。
   *
   * 🔴 これが無いと、鍵にテーマが入っていても**画面は前の色のまま**である
   * (実測: ダークにしても `<img src>` が変わらず、平均輝度 231.2 のまま)。
   * `docs/manual.md` の「配色を変えると焼き直します」は嘘だった。
   *
   * ⚠ 焼き直すのは**すでに焼いた器だけ** ── まだ見えていない器は、見えたときに
   * 新しい配色で焼かれるので、ここで先回りすると遅延読みの意味が消える。
   */
  const unwatchTheme = watchTheme(() => {
    if (disposed) return;
    gen += 1; // ⚠ 飛んでいる焼きの結果を捨てる(古い配色を最後に勝たせない)
    // ⚠ **焼き始めた器**を対象にする ── 焼き終わったもの(`urlOf`)だけだと、
    //    ちょうど焼いている最中の 1 枚が古い配色のまま残る
    for (const host of started) {
      if (!host.isConnected) continue;
      void paint({ host, source: host.getAttribute('data-pkc-mermaid-src') ?? '' }, true);
    }
  });

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

  return {
    dispose: () => {
      disposed = true;
      io.disconnect();
      unwatchTheme();
      if (idle !== 0 && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle);
      // ⚠ **表示の寿命終端で捨てる**(生成物を残さない)
      for (const u of urlOf.values()) URL.revokeObjectURL(u);
      urlOf.clear();
      started.clear();
    },
    prune: () => {
      if (disposed) return 0;
      // ⚠ 外れた器のぶんだけ返す(生きている `<img>` は壊さない)
      for (const [host, url] of [...urlOf]) {
        if (host.isConnected) continue;
        URL.revokeObjectURL(url);
        urlOf.delete(host);
        started.delete(host);
        io.unobserve(host);
      }
      let live = 0;
      for (const h of hosts) if (h.isConnected) live += 1;
      return live;
    },
  };
}
