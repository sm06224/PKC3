/**
 * mermaid を **PNG に焼いて** 出す(P8 段③)。
 *
 * > user 指示 2026-08-03(不可侵)
 * > 「**mermaid 図のエクスポートをさせるとき以外は PNG ラスタをキャッシュして、
 * > GPU レンダリングで表示して欲しい / レンダリングは表示タイミングでいいけど、
 * > スクロール追従が悪いなら、1 ドキュメント開いている場合は関連をあらかじめ
 * > レンダリングしておくとか工夫して欲しい**」
 *
 * 🔑 **画面に置くのは `<img>` 1 枚**。SVG を DOM に置くと図 1 枚が数百ノードになり、
 * スクロールのたびにレイアウトとペイントが走る。ラスタなら合成だけで済む。
 * ベクタ(SVG)が要るのは**書き出しのとき**だけで、原文は本文に残っているので
 * そのとき起こせばよい ── **PNG は捨てても再生成できるキャッシュ**である。
 *
 * ⚠ **焼き直しの条件を鍵に入れる**(user 指示):
 * 図の原文 + テーマ + 幅 + `devicePixelRatio`。どれか 1 つでも欠くと、
 * テーマを変えたのに前の色のまま / Retina でボケる、が起きる。
 *
 * ⚠ **寿命**: bytes は IDB の Blob(heap に載せない)、表示は ObjectURL で、
 * 要素が画面から消えるときに revoke(2026-07-27 の不可侵指示)。
 *
 * ⚠ mermaid は **DOM を要求する**のでワーカーへ逃がせない。だから
 * 「見えたときに描く」+「空き時間に同じ文書の残りを先読み」で、
 * **打鍵を邪魔しない**ようにする。
 */

/** 焼いた PNG の置き場(添付とは別の DB ── 捨ててよいものを混ぜない)。 */
const DB_NAME = 'pkc3-diagram-cache';
const STORE = 'png';

/**
 * キャッシュに置く上限(P8 段⑰。レビュー H-6)。
 *
 * 🔴 直す前は**上限も追い出しも無かった**。鍵は 図の原文 + テーマ + 幅 + dpr
 * なので、編集プレビューで図を打つと**静穏 tick ごとに「途中の原文」が別鍵**に
 * なり、そのすべてが永久に残る。テーマ 9 種・幅 16px 刻み・dpr でも分岐し、
 * ノートを消しても対応する PNG は残っていた。同一 origin を食い潰すと
 * 添付(`pkc3-assets`)と OPFS の sqlite まで道連れになる。
 *
 * ⚠ 件数ではなく**バイト数**で持つ ── 図 1 枚の大きさは桁で違う。
 */
export const DIAGRAM_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** 追い出しの単位(毎回 1 件ずつ消すと put のたびに走査する)。 */
const EVICT_TO = 0.8;

/**
 * 「最後に使った時刻」を書き直す**間隔**(P8 段㉗)。
 *
 * 🔴 直す前は cache hit のたびに `put({...row, at: now})` していた ── IDB の
 * `put` は行ごと書き直すので、**時刻 1 個のために PNG 全体を書き戻していた**。
 * 実測(この repo の計器 `run-raster-cap.mjs`)で 1 枚の平均は **181KB**、
 * 大きい図は **1MB 級**。図を 6 枚持つノートを開くたびに 1MB 前後の書込が走り、
 * 「書込増幅を作らない」という storage 側の規律と正面から衝突する。
 *
 * ⚠ LRU の粒度はこの間隔ぶん粗くなるが、追い出しは **32MB に触れたとき**しか
 * 走らない(実測: 平均的な図で 185 枚目)ので、5 分の粗さは順位に効かない。
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

interface CacheRow {
  png: Blob;
  /** 最後に使った時刻。**古いものから落とす**ための材料。 */
  at: number;
  size: number;
  /** 画面に置くときの幅(CSS px)。⚠ 無いときは器の幅に落ちる(旧形式)。 */
  cssWidth?: number;
}

export interface RasterKey {
  /** 図の原文。 */
  source: string;
  /** 配色(テーマを変えたら焼き直す)。 */
  theme: string;
  /**
   * その配色の実際の色。
   * 🔴 **必須にする**(P8 段⑬)── optional にすると、渡し忘れても tsc が黙り、
   * 「鍵だけテーマで散って、絵は全部同じ」という**今まさに直している不具合**が
   * そのまま戻る(この repo の規律:「材料が届いていることを pin する」)。
   */
  palette: DiagramPalette;
  /** 表示幅(CSS px)。⚠ 端数で鍵が散らないよう呼び側が丸める。 */
  width: number;
  /** 画素密度(Retina で焼き直す)。 */
  dpr: number;
  /**
   * 🔴 **何が焼いたか**(#188)。⚠ 省略時は `mermaid`(既存の鍵と互換)。
   * 産出器が違えば同じ原文でも別の絵になるので、鍵の一部である。
   */
  kind?: string;
}

/**
 * 図に使う色。**`tokens.css` の変数がそのまま出どころ**(P8 段⑬)。
 *
 * 🔴 なぜ mermaid の組み込みテーマ(`dark` / `forest` …)を使わないか ──
 * テーマは 9 つあり、**組み込みは 5 つしか無い**。名前で対応表を作ると
 * 「テーマを足したのに図の対応を足し忘れる」が必ず起きる(この repo の規律:
 * **判定を増やさない**)。CSS 変数から引けば、テーマを足した瞬間に図も追随する。
 */
export interface DiagramPalette {
  /** 図の地(`--surface`)。 */
  bg: string;
  /** 節点の面(`--surface-2`)。 */
  alt: string;
  /** 文字(`--fg`)。 */
  fg: string;
  /** 線(`--muted`)── 矢印は文字よりわずかに退く。 */
  line: string;
  /** 枠(`--border`)。 */
  border: string;
  /** 強調(`--accent`)。 */
  accent: string;
  /** 地が暗いか。mermaid が派生色を作る向きが変わる。 */
  dark: boolean;
}

/** `#abc` / `#aabbcc` / `rgb(…)` を 0–255 の 3 値へ。読めなければ null。 */
function parseColor(value: string): [number, number, number] | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1] ?? '';
    const full =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/**
 * 地が暗いか。⚠ **テーマ名の一覧で判定しない** ── 一覧は必ず古くなる。
 * 実際の色の明るさ(sRGB の相対輝度)で決めれば、新しいテーマにも自動で効く。
 */
export function isDarkColor(value: string): boolean {
  const rgb = parseColor(value);
  if (!rgb) return false; // 読めないなら明るい側に倒す(既定は light)
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]) < 0.4;
}

/** 既定(CSS が読めない環境 ── happy-dom の unit test など)。 */
const FALLBACK: DiagramPalette = {
  bg: '#ffffff',
  alt: '#f5f6f8',
  fg: '#16191d',
  line: '#59616b',
  border: '#cdd2d9',
  accent: '#14663c',
  dark: false,
};

/**
 * いま効いている配色を CSS 変数から読む。
 * ⚠ 変数が空(未定義 / 読めない)なら**その項目だけ**既定に落ちる ── 全体を
 * 既定に落とすと、1 つ欠けただけで図の色が全部戻る。
 */
export function readPalette(el: HTMLElement = document.documentElement): DiagramPalette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim();
    return raw === '' ? fallback : raw;
  };
  const bg = v('--surface', FALLBACK.bg);
  return {
    bg,
    alt: v('--surface-2', FALLBACK.alt),
    fg: v('--fg', FALLBACK.fg),
    line: v('--muted', FALLBACK.line),
    border: v('--border', FALLBACK.border),
    accent: v('--accent', FALLBACK.accent),
    dark: isDarkColor(bg),
  };
}

/**
 * 鍵の文字列化。⚠ 区切りは**原文に出ない文字**にする(衝突を作らない)。
 * ⚠ 制御文字は**エスケープで書く** ── 生バイトで埋めると grep で見えず、
 * 次に触る人が気づけない(このリポジトリの規律。`tests/repo-hygiene.test.ts` が止める)
 */
const SEP = '\u0000';

export function cacheKey(k: RasterKey): string {
  /**
   * 🔴 **種類を鍵に入れる**(#188 のレビューで判明)。
   * ⚠ 初稿は「mermaid の原文と chart の原文が同一文字列になることは実際上ない」と
   *   **確かめていない後条件**をコメントに書いていた ── CLAUDE.md が名指しで戒めている
   *   型である。産出器が 3 つ目(別倍率の書き出し / 版の違う chart.js)になった瞬間に
   *   **古い PNG を返す**。1 語混ぜれば起こりえなくなる。
   */
  return [k.kind ?? 'mermaid', k.theme, k.width, k.dpr, k.source].join(SEP);
}

/**
 * 「最後に使った時刻」を書き直すか(P8 段㉗)。
 *
 * 🔑 IDB を触らない**純関数**にする ── 判定をここへ寄せておけば単体で確かめられる。
 * ⚠ 時刻が壊れている行(`at` が数値でない / 未来)は**書き直す側**に倒す
 * ── 壊れたまま放置すると、その行が永久に「最近使った」ままで追い出されない。
 */
export function shouldTouch(at: unknown, now: number): boolean {
  if (typeof at !== 'number' || !Number.isFinite(at)) return true;
  return at > now || now - at >= TOUCH_INTERVAL_MS;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('図キャッシュを開けません'));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('図キャッシュの読み書きに失敗'));
  });
}

/**
 * 図キャッシュの DB(P8 段㉗)。**開けなくても呼び側は壊れない**
 * ── 面倒を見るのは下の `withCache()`。
 *
 * 🔴 直す前は呼び側が `tx(await db(), …).catch(…)`
 * と書いていた ── `await db()` は**引数の位置**なので、後ろの `.catch()` は
 * 掛かっていない。IDB を開けない環境(site data をブロック / DB 破損 /
 * private mode の一部)では `renderToPng` ごと reject し、mermaid の描画を
 * **一度も試さないまま**全部の図が原文のまま残った。
 * この file は 1 か所で「キャッシュは速さの話で、正しさの話ではない」と
 * 宣言していたのに、**読み側と open 側が正しさを道連れにしていた**。
 *
 * ⚠ **失敗を memo しない**(段㉗)── `dbPromise ??= openDb()` のままだと
 * reject 済みの promise を保持し、一度失敗するとその session では二度と
 * 開き直さない。open の失敗は恒久とは限らない(他タブの version change 待ち /
 * 一時的な quota)ので、**失敗したら memo を捨てて次の機会に開き直す**。
 */
let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= openDb().catch((e: unknown) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/**
 * キャッシュを触る。**開けない / 失敗したら `fallback`** を返す。
 *
 * 🔑 呼び側を全部ここに通すのは、「`await db()` を `.catch()` の外に置く」
 * という壊し方が**二度と書けない形**にするため(段㉗)。
 */
export async function withCache<T>(run: (d: IDBDatabase) => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run(await db());
  } catch {
    return fallback;
  }
}

/** mermaid 本体は**必要になるまで読まない**(初期ロードに載せない)。 */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
async function mermaid(): Promise<typeof import('mermaid').default> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

/**
 * mermaid に渡す設定。**配色ごとに作り直す**(P8 段⑬)。
 *
 * 🔴 かつてここは `initialize()` を **1 回だけ**呼び、`theme` を渡していなかった。
 * 鍵にはテーマが入っているので焼き直しは走るが、**焼き上がる絵は全テーマ同一**
 * ── ダーク系 5 テーマで図だけ明るいままだった(実測: 平均輝度 231.1 が
 * light / dark / dracula / nord / terminal で完全一致)。
 *
 * ⚠ `theme: 'base'` + `themeVariables` にする ── 組み込みテーマを名前で選ぶと
 * 対応表が要り、テーマを足すたびに更新漏れが起きる。
 */
export function configFor(p: DiagramPalette): Parameters<
  Awaited<ReturnType<typeof mermaid>>['initialize']
>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    /**
     * 🔴 **`htmlLabels` を切る**(実測で踏んだ)。既定の mermaid はラベルを
     * `<foreignObject>` で描くが、**`foreignObject` を含む SVG を canvas に
     * 描くと canvas が汚染され**、`toBlob` が
     * `SecurityError: Tainted canvases may not be exported.` で落ちる。
     * ラベルを素の `<text>` にすれば焼ける。
     * ⚠ 書き出し(ベクタ)側も同じ設定で起こす ── 画面と書き出しで
     * **図の形が変わらない**ようにするため、初期化は 1 か所に保つ。
     */
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    /**
     * 🔴 **`journey` だけは `htmlLabels` を読まない**(2026-08-28 実測、#528)。
     * この図は `textPlacement` で描き分けており、既定が `'fo'`
     * (= `<foreignObject>`)なので、上の 2 行が在っても **5 個残って焼けない**。
     *
     * 実測(製品の `configFor` 相当をそのまま当て、SVG → Image → canvas →
     * `toBlob` まで通した ── 対照群込み):
     * ```
     *                     いまのまま            journey に tspan を足す
     *   journey           fo 5 → SecurityError  fo 0 → PNG 36,344 B
     *   timeline          fo 0 → PNG  5,213 B   fo 0 → PNG  5,213 B
     *   sequenceDiagram   fo 0 → PNG  5,151 B   fo 0 → PNG  5,151 B
     *   graph TD          fo 0 → PNG  1,861 B   fo 0 → PNG  1,861 B
     * ```
     * ⚠ `timeline` も既定は `'fo'` だが**実測で 0 個**(byte まで一致)なので
     * 足さない ── 「これが無いと壊れる」と書く前に、外して壊れるのを見る。
     */
    journey: { textPlacement: 'tspan' },
    theme: 'base',
    themeVariables: {
      darkMode: p.dark,
      background: p.bg,
      mainBkg: p.alt,
      primaryColor: p.alt,
      primaryTextColor: p.fg,
      primaryBorderColor: p.border,
      secondaryColor: p.bg,
      tertiaryColor: p.bg,
      lineColor: p.line,
      textColor: p.fg,
      nodeBorder: p.border,
      clusterBkg: p.bg,
      clusterBorder: p.border,
      titleColor: p.fg,
      // ⚠ 辺のラベルは**地と同じ色で塗る** ── 既定(薄黄)だと線の上で浮く
      edgeLabelBackground: p.bg,
      noteBkgColor: p.alt,
      noteTextColor: p.fg,
      noteBorderColor: p.border,
      // 系列色つきの図(pie / journey)は**強調色を起点**にする
      pie1: p.accent,
    },
  };
}

let seq = 0;

/**
 * 🔴 **図は 1 枚ずつ焼く**(P8 段⑬)。
 *
 * `initialize()` は mermaid の**全体設定**を書き換えるので、2 枚を同時に
 * 走らせると「後から始まった方の配色で、先の 1 枚が焼ける」が起きうる
 * (先読みと「見えたから描く」は実際に重なる)。列に並べれば起きない。
 * ⚠ 重い仕事を並べても損はしない ── mermaid は DOM を使うので、
 * どのみちメインスレッドで 1 枚ずつしか進まない。
 */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  // ⚠ 失敗を鎖に残さない(残すと次の 1 枚が未処理の reject に巻き込まれる)
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** 設定を当ててから描く。⚠ **この 2 手はいつも隣り合う**(離すと混ざる)。 */
async function renderWith(id: string, source: string, p: DiagramPalette): Promise<string> {
  const m = await mermaid();
  m.initialize(configFor(p));
  const { svg } = await m.render(id, source);
  return svg;
}

/**
 * SVG 文字列を PNG の Blob に焼く。
 *
 * ⚠ `devicePixelRatio` 倍で焼く ── 等倍で焼くと Retina で必ずボケる。
 */
export interface Raster {
  png: Blob;
  /**
   * 画面に置くときの幅(CSS px)。
   * 🔴 **器の幅とは限らない**(P8 段⑱。レビュー H)。かつては器の幅いっぱいに
   * 引き伸ばしていたので、**2 節点の図が 875×1286px** を占めていた ──
   * 図は「情報の量ぶんの大きさ」で置くのが業務画面の作法。
   */
  cssWidth: number;
}

/**
 * SVG の**本来の大きさ**を `viewBox` から読む。
 *
 * 🔴 **`img.naturalWidth` を信じない**(P8 段⑱ の変異試験で判明)。mermaid は
 * 既定で `width="100%" style="max-width: Npx"` を出すので、SVG を `Image` に
 * 読ませたときの自然幅は **`min(300, N)`** になる ── 300 は「大きさの分からない
 * 置換要素」に対するブラウザの既定値である。実測: 2 節点の図は 82px(max-width が
 * 効いて正しい)だが、24 節点の図も **300px**(既定値に頭打ち)になり、
 * **大きい図は 300px で焼いて引き伸ばす** = ぼやける、という壊れ方をしていた。
 * `viewBox` は図の実寸で必ず入っているので、そこから読む。
 */
export function svgViewBox(svg: string): { w: number; h: number } | null {
  const m = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/.exec(svg);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

/**
 * 1 枚の canvas に許す**面積**と**辺の長さ**(P8 段㉗)。
 *
 * 🔴 直す前は clamp が 1 つも無く、`h = cssWidth × 縦横比 × dpr` がそのまま
 * canvas の高さになっていた。実測(headless Chromium。詳細は
 * `docs/development/p8-raster-cache-limits-2026-08.md`):
 *
 * | 図(縦に伸びる chain) | dpr | PNG 実寸 | canvas の裏バッファ | 画面での幅 |
 * |---|---|---|---|---|
 * | 120 節 | 3 | 369 × **35,402** px | **49.8 MB** | **123 px** |
 * | 40 節 | 3 | 342 × 11,916 px | 15.5 MB | 114 px |
 *
 * ── **123px 幅で見せる図のために 50MB 確保していた**。`cssWidth` は
 * `min(器幅, 図の実寸)` で頭打ちになるが、**縦横比は頭打ちにならない**ので
 * 縦に伸びる図(`graph TD` の chain は実データで普通に出る)で発散する。
 * これは「継続使用の常駐メモリ」を最優先せよという不可侵指示に真っ向から反する。
 *
 * ⚠ さらに面積上限を越えると `canvas.toBlob` が **null を渡す**(仕様)ので、
 * その図はその端末で**永久に出ない**(鍵が同じなので再訪しても同じ経路)。
 * iOS Safari の面積上限は約 16.7M px なので、**そこより下**に置く。
 *
 * 🔑 **面積を主、辺を従**にする(段㉗ の再測で決めた)。最初は辺を 8,192 に
 * していたが、それだと **dpr 1 の縦長の図まで縮んだ**(123 × 11,801 の図が
 * 倍率 0.69 → 表示幅より小さく焼いて拡大 = ぼける)。実際に効かせたいのは
 * メモリで、それは**面積**で決まる ── 辺は「canvas がそもそも作れない」を
 * 避けるためだけの帯にする。
 *
 * 4M px = 裏バッファ **16MB**。普通の図(640×400 を dpr 2)は 1.0M px なので
 * まったく触らない ── 縮むのは病的に長い図だけである。
 */
export const MAX_RASTER_PX = 4 * 1024 * 1024;
/**
 * 辺の上限。⚠ Chromium の canvas は **65,535px** を越えると作れない ──
 * そこに触れる手前で止める帯であって、画質を決める数字ではない。
 */
export const MAX_RASTER_DIM = 32768;

/**
 * 焼くときの**倍率**を決める(P8 段㉗)。
 *
 * 🔑 IDB も canvas も触らない**純関数**にする ── 判定をここへ寄せておけば、
 * happy-dom でも単体で確かめられる(`rasterize` は canvas が要るので呼べない)。
 *
 * ⚠ 返り値は **1 を下回りうる** ── 巨大な図では等倍すら許さない。
 * ぼけるのは困るが、**出ない / 50MB 確保するよりはよい**。
 */
export function rasterScale(cssWidth: number, cssHeight: number, dpr: number): number {
  const w = Math.max(1, cssWidth);
  const h = Math.max(1, cssHeight);
  return Math.min(
    Math.max(dpr, 0) || 1,
    Math.sqrt(MAX_RASTER_PX / (w * h)),
    MAX_RASTER_DIM / w,
    MAX_RASTER_DIM / h,
  );
}

/**
 * 焼く**実寸**(P8 段㉗)。
 *
 * 🔑 「倍率」と「実寸」を別々に持たない ── `rasterize` 側で `round` して、
 * test 側でも `round` して…と**同じ規則を 2 か所に生やす**と必ずずれる
 * (この repo の規律:「規則を 1 つに寄せる」)。実際に踏んだ: 倍率だけを
 * 寄せて実寸は呼び側で `Math.round` していたら、**両辺が切り上がって面積が
 * 上限を 1,176px 超えた**(2120 × 1979 = 4,195,480 / 上限 4,194,304)。
 *
 * ⚠ **切り捨てる** ── 丸めると上限を越えうる。1px 足りない側に倒す。
 */
export function rasterSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): { w: number; h: number } {
  const scale = rasterScale(cssWidth, cssHeight, dpr);
  return {
    w: Math.max(1, Math.floor(Math.max(1, cssWidth) * scale)),
    h: Math.max(1, Math.floor(Math.max(1, cssHeight) * scale)),
  };
}

export async function rasterize(svg: string, width: number, dpr: number): Promise<Raster> {
  // 🔴 **器より小さい図は引き伸ばさない**(P8 段⑱)。図の実寸で頭打ちにする
  //    ── 器いっぱいに広げると、小さい図が画面を占領して密度が落ちる
  const box = svgViewBox(svg);
  const cssWidth = Math.max(1, Math.round(box ? Math.min(width, box.w) : width));
  const ratio = box ? box.h / box.w : 0;
  /**
   * ⚠ **根の `<svg>` に実寸を書き戻す必要は無い**(実測。段⑱ で一度書いて消した)。
   * 「読ませた自然幅 300px の絵を `drawImage` が引き伸ばすのでは」と考えて
   * `width` / `height` / `max-width` を差し替える処理を入れたが、**出来上がる
   * PNG は 1 バイトも変わらなかった**(800×400 に描いた 2 枚の ImageData が
   * checksum まで一致)── Blink は SVG 画像を**描く大きさで焼き直す**。
   * 効くのは「どれだけの大きさで描くか」だけなので、そこだけを決める。
   */
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('図を画像にできません'));
      img.src = url;
    });
    // viewBox が無い図(想定外)だけ、読めた自然比に落ちる
    const cssHeight = Math.max(
      1,
      box ? cssWidth * ratio : (img.naturalHeight / Math.max(1, img.naturalWidth)) * cssWidth,
    );
    // 🔴 **上限に収まるところまで落とす**(段㉗。上の実測表を参照)
    const { w, h } = rasterSize(cssWidth, cssHeight, dpr);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('図を描く場所が作れません');
    ctx.drawImage(img, 0, 0, w, h);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('図を PNG にできません'))), 'image/png');
    });
    return { png, cssWidth };
  } finally {
    // ⚠ **必ず捨てる**(焼き終わった時点が SVG の寿命の終わり)
    URL.revokeObjectURL(url);
  }
}

/**
 * 図 1 枚を PNG にして返す(キャッシュがあればそれ)。
 * ⚠ 返るのは Blob ── ObjectURL を作って捨てるのは**表示する側**の責務。
 */
export async function renderToPng(key: RasterKey): Promise<Raster> {
  return renderCachedPng(key, async () =>
    serialized(async () => {
      seq += 1;
      const svg = await renderWith(`pkc3-mmd-${seq}`, key.source, key.palette);
      return rasterize(svg, key.width, key.dpr);
    }),
  );
}

/**
 * 🔴 **焼いたものを貯める所は 1 つ**(#188 で chart が加わったときに確立)。
 *
 * 鍵・LRU・上限・追い出しは**図の種類に依らない**ので、ここへ寄せる ──
 * chart 用にもう 1 つ cache を作ると、上限が 2 つになり(32MB × 2)、
 * 追い出しの規則も 2 か所に散る(§7「同じ判定が複数の場所にある」)。
 * ⚠ 種類の違いは `produce`(どうやって PNG にするか)だけである。
 * ⚠ 鍵に種類が混ざらないよう、呼び側は `source` に**原文そのもの**を渡すこと
 *   (mermaid の原文と chart の原文が同一文字列になることは実際上ない)。
 */
export async function renderCachedPng(
  key: RasterKey,
  produce: () => Promise<Raster>,
): Promise<Raster> {
  const k = cacheKey(key);
  const hit = await withCache<unknown>((d) => tx<unknown>(d, 'readonly', (s) => s.get(k)), null);
  if (hit !== null && typeof hit === 'object' && 'png' in hit) {
    const row = hit as CacheRow;
    // ⚠ 使ったことを記録する(追い出しの順が「最後に使った順」になる)。
    //    失敗しても描画は続ける。
    // 🔴 ただし**毎回は書かない**(段㉗)── `put` は行ごと書き直すので、
    //    時刻 1 個のために PNG 全体(平均 181KB)を書き戻すことになる
    if (shouldTouch(row.at, Date.now())) {
      void withCache(
        (d) => tx(d, 'readwrite', (s) => s.put({ ...row, at: Date.now() } satisfies CacheRow, k)),
        undefined,
      );
    }
    return { png: row.png, cssWidth: row.cssWidth ?? key.width };
  }
  // ⚠ 旧形式(Blob をそのまま入れていた)も読める ── 互換は双方向で考える
  if (hit instanceof Blob) return { png: hit, cssWidth: key.width };

  const raster = await produce();
  // ⚠ 保存に失敗しても**描画は続ける**(キャッシュは速さの話で、正しさの話ではない)
  await withCache(
    (d) =>
      tx(d, 'readwrite', (s) =>
        s.put(
          {
            png: raster.png,
            at: Date.now(),
            size: raster.png.size,
            cssWidth: raster.cssWidth,
          } satisfies CacheRow,
          k,
        ),
      ),
    undefined,
  );
  void evictDiagramCache().catch(() => undefined);
  return raster;
}

/** 追い出しが同時に何本も走らないようにする(走査は 1 本で足りる)。 */
let evicting = false;

/**
 * 鍵と中身を**対で**舐める(P8 段㉑)。
 *
 * 🔴 直す前は `getAll()` と `getAllKeys()` を**別々のトランザクション**で取り、
 * 添字で突き合わせていた。この 2 本の間には待たれていない書込が実在する
 * (LRU タッチの `put` と、次の図の `put`)── IDB は key 順で返すので、
 * **先に並ぶ鍵が 1 件挿入されただけで以降の添字が全部ずれ**、
 * 「いま見ている図」を古いと誤判定して消す。削除が挟まれば `keys[i]` が
 * `undefined` になり、`delete(undefined)` の DataError が呼び側の
 * `.catch(() => undefined)` に握り潰されて**追い出しが黙って止まる**
 * ── そうなると 32MB の上限は無いのと同じである。
 * ⚠ カーソルなら 1 トランザクションの中で対のまま取れる(突き合わせが要らない)。
 */
function listCacheEntries(
  d: IDBDatabase,
): Promise<Array<{ key: IDBValidKey; at: number; size: number }>> {
  return new Promise((resolve, reject) => {
    const out: Array<{ key: IDBValidKey; at: number; size: number }> = [];
    const req = d.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      const row = cur.value as Partial<CacheRow>;
      out.push({
        key: cur.key,
        at: typeof row.at === 'number' ? row.at : 0,
        size: typeof row.size === 'number' ? row.size : (row.png?.size ?? 0),
      });
      cur.continue();
    };
    req.onerror = () => reject(req.error ?? new Error('図キャッシュを読めません'));
  });
}

/**
 * **どれを落とすかを決める**(P8 段⑰)。
 *
 * 🔑 IDB を触らない**純関数**にする ── 判定をここへ寄せておけば、
 * happy-dom に `indexedDB` が無くても単体で確かめられる(依存も増やさない)。
 * ⚠ 落とすのは「最後に使った時刻」の古い順 ── 作った順だと、よく使う図が
 * 先に消えて毎回焼き直しになる。
 */
export function planEviction(
  items: readonly { key: IDBValidKey; at: number; size: number }[],
  maxBytes: number,
): IDBValidKey[] {
  let total = items.reduce((n, it) => n + it.size, 0);
  if (total <= maxBytes) return [];
  const target = maxBytes * EVICT_TO;
  const drop: IDBValidKey[] = [];
  for (const it of [...items].sort((a, b) => a.at - b.at)) {
    if (total <= target) break;
    drop.push(it.key);
    total -= it.size;
  }
  return drop;
}

/**
 * 上限を超えていたら**古いものから**落とす(P8 段⑰)。
 * ⚠ 落とすのは「最後に使った時刻」の古い順 ── 作った順だと、よく使う図が
 * 先に消えて毎回焼き直しになる。
 */
export async function evictDiagramCache(
  maxBytes = DIAGRAM_CACHE_MAX_BYTES,
): Promise<number> {
  if (evicting) return 0;
  evicting = true;
  try {
    return await withCache(async (d) => {
      const items = await listCacheEntries(d);
      const drop = planEviction(items, maxBytes);
      let done = 0;
      for (const key of drop) {
        // ⚠ 1 件の失敗で**残りを諦めない** ── 途中で throw すると、その回の
        //   追い出しがまるごと止まる(呼び側の catch に握り潰されて静かに)
        try {
          await tx(d, 'readwrite', (s) => s.delete(key));
          done += 1;
        } catch {
          /* この 1 件は次の機会に落ちる */
        }
      }
      return done;
    }, 0);
  } finally {
    evicting = false;
  }
}

/**
 * 書き出し用のベクタ(**画面には使わない**)。
 * ⚠ 画面と**同じ配色**で起こす ── 見えている図と落ちるファイルの色が違うのは、
 * 「いま見えている物を保存した」という期待を裏切る。
 */
export async function renderToSvg(source: string, palette: DiagramPalette): Promise<string> {
  return serialized(async () => {
    seq += 1;
    return renderWith(`pkc3-mmd-x${seq}`, source, palette);
  });
}

/** キャッシュを空にする(図は原文から再生成できるので、いつ捨ててもよい)。 */
export async function clearDiagramCache(): Promise<void> {
  await withCache((d) => tx(d, 'readwrite', (s) => s.clear()), undefined);
}
