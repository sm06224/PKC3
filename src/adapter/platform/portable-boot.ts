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
import { DbImageStore } from './storage/db-image-store';

export const BUNDLE_SELECTOR = 'script[data-pkc-bundle]';
export const IMAGE_SELECTOR = 'script[data-pkc-db-image]';

/** 焼き込まれた印。⚠ 無い / 壊れていれば `null` = 素の PKC3 と同じ。 */
export function readBundle(doc: Document): PortableBundle | null {
  return parseBundleTag(doc.querySelector(BUNDLE_SELECTOR)?.textContent ?? null);
}

/**
 * 焼き込まれた DB 画像を取り出し、**その場で DOM から外す**。
 *
 * 🔴 **外すのが本題である**(正本 doc §4.6「boot でクローンし DOM から除去」)──
 * base64 の文字列は画像の 4/3 の大きさで、`<script>` に残っている限り
 * **document の寿命ぶん常駐する**(4MB の DB なら 5.5MB が居座る)。
 * ⚠ 復号に失敗しても外す ── 読めない物を抱え続ける理由は無い。
 */
export function takeEmbeddedImage(doc: Document): Uint8Array | null {
  const el = doc.querySelector(IMAGE_SELECTOR);
  if (el === null) return null;
  const text = (el.textContent ?? '').trim();
  el.remove();
  if (text === '') return null;
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.byteLength > 0 ? out : null;
  } catch {
    /**
     * ⚠ **黙って `null` にしない**のが正しいように見えるが、ここは逆である ──
     * 焼き込みが壊れているとき、器に user の編集が入っていれば**そちらで開ける**。
     * 🔑 だから「配りものは無かった」に畳み、判定は `chooseImage` に任せる。
     */
    return null;
  }
}

export interface PortableStart {
  readonly bundle: PortableBundle;
  /** sqlite 側へ渡す器の名前(OPFS を使わないので実質は識別子)。 */
  readonly dbName: string;
  /** `init` に渡す画像。`null` なら空から始める。 */
  readonly image: Uint8Array | null;
  readonly choice: ImageChoice;
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

  const embedded = takeEmbeddedImage(doc);
  const store = make(bundle.id);

  let stored: Awaited<ReturnType<DbImageStore['read']>> = null;
  let readError: string | null = null;
  try {
    stored = await store.read();
  } catch (e) {
    readError = String(e);
  }

  const choice: ImageChoice =
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

  const image =
    choice.use === 'stored' ? (stored?.image ?? null) : choice.use === 'embedded' ? embedded : null;

  return { bundle, dbName: bundleSqliteName(bundle.id), image, choice, store };
}
