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

export interface RasterKey {
  /** 図の原文。 */
  source: string;
  /** 配色(テーマを変えたら焼き直す)。 */
  theme: string;
  /** 表示幅(CSS px)。⚠ 端数で鍵が散らないよう呼び側が丸める。 */
  width: number;
  /** 画素密度(Retina で焼き直す)。 */
  dpr: number;
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
  mermaidPromise ??= import('mermaid').then((m) => {
    m.default.initialize({
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
    });
    return m.default;
  });
  return mermaidPromise;
}

let seq = 0;

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
  if (hit instanceof Blob) return hit;

  const m = await mermaid();
  seq += 1;
  const { svg } = await m.render(`pkc3-mmd-${seq}`, key.source);
  const png = await rasterize(svg, key.width, key.dpr);
  // ⚠ 保存に失敗しても**描画は続ける**(キャッシュは速さの話で、正しさの話ではない)
  await tx(await db(), 'readwrite', (s) => s.put(png, k)).catch(() => undefined);
  return png;
}

/** 書き出し用のベクタ(**画面には使わない**)。 */
export async function renderToSvg(source: string): Promise<string> {
  const m = await mermaid();
  seq += 1;
  const { svg } = await m.render(`pkc3-mmd-x${seq}`, source);
  return svg;
}

/** キャッシュを空にする(図は原文から再生成できるので、いつ捨ててもよい)。 */
export async function clearDiagramCache(): Promise<void> {
  await tx(await db(), 'readwrite', (s) => s.clear());
}
