/**
 * 🔴 **添付から読む囲み(```` ```csv asset:k ````)の器を、中身で埋める**(#444 段① / #1087 A4)。
 *
 * `markdown-render.ts` は囲みを `<div data-pkc-fence-asset-key="k" data-pkc-fence-asset-info="csv">` の
 * **器**にするところまでやる ── 添付は IDB に在り、描画は同期なので、**埋めるのはここ**である。
 *
 * ⚠ 呼ぶ面は複数ある(§7)── 本文の面(`detail.ts`)/ 付箋の板(`place-embed.ts`)/
 *   章の埋め込み(`section-embed.ts`)。かつて本文の面にだけ在り、**埋め込みの中では
 *   「このコードブロックの中身は添付にあります」の案内のまま中身が出なかった**。
 *   章の別窓(`chapter-windows.ts`)は窓の寿命に合わせた別の書き方で、読み方は
 *   `features/asset/fence-asset-read.ts` の 1 本を共有している。
 */
import { readFenceAssetText } from '@features/asset/fence-asset-read';
import { renderFenceFromAsset } from '@features/markdown/markdown-render';

/**
 * 添付から中身を取るコード枠が読めなかったときの断り文。
 * 🔑 本文の面と章の別ウィンドウ(#1044 段4)で**同じ 1 本**を使う。
 */
export function fenceAssetUnreadableText(why: string): string {
  return `このコードブロックの中身(添付)を読み込めません: ${why}`;
}

export interface FenceHydrateOptions {
  /** 埋める器(`[data-pkc-fence-asset-key]`)。 */
  readonly hosts: readonly HTMLElement[];
  /** 鍵 → Blob。`null` = 添付の置き場が無い(器ごとに断り文を出す)。 */
  readonly getBlob: ((key: string) => Promise<Blob | null>) | null;
  /** 読んだ字の控え(打鍵のたびに IDB を読まない)。⚠ 持ち主が手放す時期を決める。 */
  readonly texts: Map<string, string>;
  readonly env: { readonly allowExternalImages: boolean; readonly currentContainerId: string };
  /** 待っている間に世代が変わった / 器が捨てられた = 真。真なら何も触らない。 */
  readonly stale: () => boolean;
  /**
   * 差し替える塊を、画面へ入れる前に整える(板・章の埋め込みは読み取り専用の掃除を通す)。
   * 塊は一時の `<div>` に入っている。
   */
  readonly prepare?: (holder: HTMLElement) => void;
  /** 差し替えた塊(図の器を埋めるなど)。 */
  readonly onReplaced?: (next: Element) => void;
}

/** 添付から読む囲みの「読み込み中」の印(`markdown-render.ts` が器の中の案内に立て、埋めるか断り文にすると外れる)。 */
export const FENCE_ASSET_PENDING_SELECTOR = '[data-pkc-fence-asset-pending]';

/**
 * 🔴 **本文の中に、読み込み中の囲み・章の埋め込みが在るか**(PDF で刷る前に待つ判定。#1087)。
 * ⚠ 判定は**この 1 つ**に寄せる ── 章の埋め込み(`SECTION_LOADING_SELECTOR`)だけ見ると、
 *   付箋の板・章の中の「添付から読む囲み」が案内のまま刷られる。本文直下の囲み(読む面)も同じ印を持つので一緒に効く。
 */
export function bodyEmbedsLoading(
  root: ParentNode,
  bodyHostSelector: string,
  sectionLoadingSelector: string,
): boolean {
  // ⚠ 本文の器の選択子は呼び側が渡す(`detail.ts` の `BODY_HOST_SELECTOR` ── 持ち越した器を掴まない。ここから detail を引くと循環する)
  const body = root.querySelector(bodyHostSelector);
  if (body === null) return false;
  return body.querySelector(`${sectionLoadingSelector}, ${FENCE_ASSET_PENDING_SELECTOR}`) !== null;
}

/** 器の中の「読み込み中」を断り文にする。 */
function fail(host: HTMLElement, why: string): void {
  const pending = host.querySelector(FENCE_ASSET_PENDING_SELECTOR);
  if (!pending) return;
  pending.setAttribute('data-pkc-fence-asset-error', '');
  pending.removeAttribute('data-pkc-fence-asset-pending');
  pending.textContent = fenceAssetUnreadableText(why);
}

/**
 * 器を全部埋める。
 *
 * ⚠ **読めなかったら理由を出す**(#264 段② と同じ向き)── 黙って器のままにしない。
 *   囲みに書いてあった控え(`data-pkc-fence-asset-fallback`)は**残す**。
 * ⚠ 待っている間に `stale()` になったら**何も触らない**(器も断り文も)。
 */
export async function hydrateFenceHosts(o: FenceHydrateOptions): Promise<void> {
  const { getBlob, texts, env } = o;
  // 🔴 外れた器は読まない(旧い読み込みが、描き直した後も添付を読み続けない)
  const hosts = o.hosts.filter((h) => h.isConnected);
  if (hosts.length === 0) return;
  if (o.stale()) return;
  /**
   * 🔴 **この 1 回で 1 つ** ── `-both` の切替 id は「同じ(言語, 中身)の中で何番目か」で決まり、
   *   その数はこの object が憶える。囲みごとに作り直すと、同じ囲みを 2 つ書いたとき id が衝突する。
   */
  const renderEnv: { currentContainerId?: string; allowExternalImages?: boolean } = {
    currentContainerId: env.currentContainerId,
    allowExternalImages: env.allowExternalImages,
  };
  await Promise.all(
    [...new Set(hosts.map((h) => h.getAttribute('data-pkc-fence-asset-key') ?? ''))].map(
      async (key) => {
        const mine = hosts.filter(
          (h) => (h.getAttribute('data-pkc-fence-asset-key') ?? '') === key,
        );
        let text = texts.get(key);
        if (text === undefined) {
          if (!getBlob) {
            for (const h of mine) fail(h, 'いま添付を読み込めません(読み込みの準備ができていません)');
            return;
          }
          /**
           * 🔑 **読み方は書き出しと同じ 1 本**(#444 段②で寄せた)── 上限も断り文も
           *   `features/asset/fence-asset-read.ts` が持つ。
           */
          const got = await readFenceAssetText(getBlob, key);
          if (o.stale()) return;
          if (!got.ok) {
            for (const h of mine) fail(h, got.why);
            return;
          }
          text = got.text;
          texts.set(key, text);
        }
        for (const h of mine) {
          // 🔴 同じ枠を描き直すと旧い器は外れる ── 外れた器は差し替えない(新しい器は新しい読み込みが埋める)
          if (!h.isConnected) continue;
          const info = h.getAttribute('data-pkc-fence-asset-info') ?? '';
          /**
           * ⚠ **器ごと差し替える** ── `renderFenceFromAsset` が返すのは `pkc-md-block` を含む
           *   **塊そのもの**なので、中へ入れると二重になる。
           * ⚠ 位置の印(`data-pkc-source-line`)は器が持っているので、差し替えた要素へ**写す**。
           */
          const holder = document.createElement('div');
          holder.innerHTML = renderFenceFromAsset(info, text, renderEnv);
          o.prepare?.(holder);
          const next = holder.firstElementChild;
          if (!next) {
            fail(h, '描けませんでした');
            continue;
          }
          for (const name of ['data-pkc-source-line', 'data-pkc-source-end']) {
            const v = h.getAttribute(name);
            if (v !== null) next.setAttribute(name, v);
          }
          h.replaceWith(next);
          o.onReplaced?.(next);
        }
      },
    ),
  );
}
