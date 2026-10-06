/**
 * 🔴 **可搬単一 HTML の起動**(#400 段③)── 印を読み、どの中身を開くか決める。
 *
 * ## 🔑 なぜ `main.ts` に書かないか
 *
 * `src/main.ts` は **原文を `readFileSync` で読む test しか無い**(CLAUDE.md §2)──
 * そこに判断を置くと、**全 test 緑のまま取り違える**。ここは
 * 「どの器を開くか」= 間違えたら user のノートが消える判断なので、取り出す。
 *
 * ## ⚠ 素の PKC3 では、この module は何もしない
 *
 * 印(`<script type="application/json" data-pkc-bundle>`)は**畳んだ HTML にしか
 * 焼かれない**。`https://` 配信の `index.html` には無いので `readBundle` は `null` を
 * 返し、`main.ts` はいままでどおりの経路へ進む。
 */
import {
  bundleSqliteName,
  chooseImage,
  parseBundleTag,
  type ImageChoice,
  type PortableBundle,
} from '@features/portable/bundle';
import { humanBytes } from '@features/human-bytes';
import { DbImageStore } from './storage/db-image-store';

export const BUNDLE_SELECTOR = 'script[data-pkc-bundle]';
export const IMAGE_SELECTOR = 'script[data-pkc-db-image]';

/** 焼き込まれた印。⚠ 無い / 壊れていれば `null` = 素の PKC3 と同じ。 */
export function readBundle(doc: Document): PortableBundle | null {
  return parseBundleTag(doc.querySelector(BUNDLE_SELECTOR)?.textContent ?? null);
}

/** `takeEmbeddedImage` の結果。⚠ `failure` が在るときは `image` は必ず `null`。 */
export interface EmbeddedTake {
  readonly image: Uint8Array | null;
  /** 読み戻せなかった理由(user に見せる文)。⚠ 焼き込みが無い / 空なら `null`(失敗ではない)。 */
  readonly failure: string | null;
}

/**
 * 焼き込まれた base64 の大きさ(バイト)。
 *
 * 🔴 **`textContent` を読まずに数える** ── 読めないほど大きいときに呼ぶので、読めば同じ所で
 * 落ちる。⚠ HTML の読み手は長い字を**複数の Text node に割ることがある**ので、合計する。
 */
function embeddedBytesOf(el: Element): number {
  let chars = 0;
  for (const n of Array.from(el.childNodes)) {
    // 3 = Text node(⚠ 要素などの `length` を拾わない)
    if (n.nodeType === 3) chars += (n as Text).length;
  }
  return Math.floor((chars * 3) / 4);
}

/**
 * 焼き込まれた DB 画像を取り出し、**その場で DOM から外す**。
 *
 * 🔴 **外すのが本題である**(正本 doc §4.6「boot でクローンし DOM から除去」)──
 * base64 の文字列は画像の 4/3 の大きさで、`<script>` に残っている限り
 * **document の寿命ぶん常駐する**(4MB の DB なら 5.5MB が居座る)。
 * ⚠ 復号に失敗しても外す ── 読めない物を抱え続ける理由は無い。
 *
 * 🔴 **読めなかったことを、黙って「無かった」に畳まない**(#996)。
 * 文字列には上限があり(V8 で約 2^29 字)、超えた 1 枚は **`textContent` を読んだ時点で**
 * `RangeError` になる。⚠ 古い版で焼いた 1 枚や、上限の低い端末で開く 1 枚は今も在りうる。
 * 畳むと、user は**空の PKC が開いた理由を知らず、バックアップが壊れたとも気づけない**。
 * 🔑 だから理由を `failure` で返す。⚠ **`textContent` の読み出しも `try` の中**に置く
 * (外に在ると、起動ごと止まる)。
 */
export function takeEmbeddedImage(doc: Document): EmbeddedTake {
  const el = doc.querySelector(IMAGE_SELECTOR);
  if (el === null) return { image: null, failure: null };
  try {
    const text = (el.textContent ?? '').trim();
    if (text === '') return { image: null, failure: null };
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { image: out.byteLength > 0 ? out : null, failure: null };
  } catch (e) {
    if (e instanceof RangeError) {
      return {
        image: null,
        failure:
          'この HTML ファイルに埋め込まれた中身が大きすぎて、このブラウザでは読み戻せません' +
          `(約 ${humanBytes(embeddedBytesOf(el))})。一式のバックアップ(.pkc3-full.zip など)から取り込んでください`,
      };
    }
    return {
      image: null,
      failure: `この HTML ファイルに埋め込まれた中身が読み取れない形になっています(${String(e)})`,
    };
  } finally {
    el.remove();
  }
}

/**
 * 🔴 **読み戻せなかった理由を `why` に足す**(#996)。⚠ 判定(`chooseImage`)そのものは変えない。
 * 🔑 `fresh` のときは「空で開く」ことが、`stored` のときは「配りものは読めなかったが、この端末の
 * 記録で開く」ことが、**user の読む字として**伝わる形にする。
 */
export function withEmbeddedFailure(choice: ImageChoice, failure: string | null): ImageChoice {
  if (failure === null) return choice;
  return {
    use: choice.use,
    why:
      choice.use === 'fresh'
        ? `${failure}。空の状態で開きます(${choice.why})`
        : `${failure}。${choice.why}`,
  };
}

export interface PortableStart {
  readonly bundle: PortableBundle;
  /** sqlite 側へ渡す器の名前(OPFS を使わないので実質は識別子)。 */
  readonly dbName: string;
  /** `init` に渡す画像。`null` なら空から始める。 */
  readonly image: Uint8Array | null;
  readonly choice: ImageChoice;
  /** 焼き込みを読み戻せなかった理由(`choice.why` にも入っている)。⚠ 画面へ出す合図に使う。 */
  readonly embeddedFailure: string | null;
  readonly store: DbImageStore;
}

/**
 * 起動時に 1 回だけ呼ぶ。
 *
 * ⚠ **器の読みが落ちても起動は続ける** ── 器が壊れている / quota が尽きている
 * 端末で「起動できません」にすると、**配られた中身すら読めなくなる**。
 * 🔑 読めなかったことは `choice.why` に載せて、user に見せる。
 */
export async function resolvePortableStart(
  doc: Document,
  make: (id: string) => DbImageStore = (id) => new DbImageStore(id),
): Promise<PortableStart | null> {
  const bundle = readBundle(doc);
  if (bundle === null) return null;

  const { image: embedded, failure: embeddedFailure } = takeEmbeddedImage(doc);
  const store = make(bundle.id);

  let stored: Awaited<ReturnType<DbImageStore['read']>> = null;
  let readError: string | null = null;
  try {
    stored = await store.read();
  } catch (e) {
    readError = String(e);
  }

  const picked: ImageChoice =
    readError !== null
      ? {
          use: embedded ? 'embedded' : 'fresh',
          why: `この端末の記録を読めませんでした(${readError})`,
        }
      : chooseImage({
          bundle,
          stored:
            stored === null
              ? null
              : {
                  bundleId: stored.bundleId,
                  exportedAt: stored.exportedAt,
                  savedAt: stored.savedAt,
                  bytes: stored.bytes,
                },
          embeddedBytes: embedded?.byteLength ?? 0,
        });

  const choice = withEmbeddedFailure(picked, embeddedFailure);

  const image =
    choice.use === 'stored' ? (stored?.image ?? null) : choice.use === 'embedded' ? embedded : null;

  return { bundle, dbName: bundleSqliteName(bundle.id), image, choice, embeddedFailure, store };
}
