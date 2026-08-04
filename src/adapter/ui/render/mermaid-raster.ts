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

interface CacheRow {
  png: Blob;
  /** 最後に使った時刻。**古いものから落とす**ための材料。 */
  at: number;
  size: number;
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
  return [k.theme, k.width, k.dpr, k.source].join(SEP);
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

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= openDb();
  return dbPromise;
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
export async function rasterize(svg: string, width: number, dpr: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('図を画像にできません'));
      img.src = url;
    });
    const ratio = img.naturalHeight / Math.max(1, img.naturalWidth);
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(width * ratio * dpr));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('図を描く場所が作れません');
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('図を PNG にできません'))), 'image/png');
    });
  } finally {
    // ⚠ **必ず捨てる**(焼き終わった時点が SVG の寿命の終わり)
    URL.revokeObjectURL(url);
  }
}

/**
 * 図 1 枚を PNG にして返す(キャッシュがあればそれ)。
 * ⚠ 返るのは Blob ── ObjectURL を作って捨てるのは**表示する側**の責務。
 */
export async function renderToPng(key: RasterKey): Promise<Blob> {
  const k = cacheKey(key);
  const hit = await tx<unknown>(await db(), 'readonly', (s) => s.get(k)).catch(() => null);
  if (hit !== null && typeof hit === 'object' && 'png' in hit) {
    const row = hit as CacheRow;
    // ⚠ 使ったことを記録する(追い出しの順が「最後に使った順」になる)。
    //    失敗しても描画は続ける
    void tx(await db(), 'readwrite', (s) =>
      s.put({ ...row, at: Date.now() } satisfies CacheRow, k),
    ).catch(() => undefined);
    return row.png;
  }
  // ⚠ 旧形式(Blob をそのまま入れていた)も読める ── 互換は双方向で考える
  if (hit instanceof Blob) return hit;

  const png = await serialized(async () => {
    seq += 1;
    const svg = await renderWith(`pkc3-mmd-${seq}`, key.source, key.palette);
    return rasterize(svg, key.width, key.dpr);
  });
  // ⚠ 保存に失敗しても**描画は続ける**(キャッシュは速さの話で、正しさの話ではない)
  await tx(await db(), 'readwrite', (s) =>
    s.put({ png, at: Date.now(), size: png.size } satisfies CacheRow, k),
  ).catch(() => undefined);
  void evictDiagramCache().catch(() => undefined);
  return png;
}

/** 追い出しが同時に何本も走らないようにする(走査は 1 本で足りる)。 */
let evicting = false;

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
    const d = await db();
    const rows = await tx<unknown[]>(d, 'readonly', (s) => s.getAll());
    const keys = await tx<IDBValidKey[]>(d, 'readonly', (s) => s.getAllKeys());
    const items = rows.map((r, i) => {
      const row = r as Partial<CacheRow>;
      return {
        key: keys[i]!,
        at: typeof row.at === 'number' ? row.at : 0,
        size: typeof row.size === 'number' ? row.size : (row.png?.size ?? 0),
      };
    });
    const drop = planEviction(items, maxBytes);
    for (const key of drop) await tx(d, 'readwrite', (s) => s.delete(key));
    return drop.length;
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
  await tx(await db(), 'readwrite', (s) => s.clear());
}
