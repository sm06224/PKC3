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
import { errorText } from '@features/error-text';
import {
  bundleSqliteName,
  checkImageParts,
  chooseImage,
  decodeImageParts,
  parseBundleTag,
  type ImageChoice,
  type PortableBundle,
} from '@features/portable/bundle';
import { humanBytes } from '@features/human-bytes';
import { DbImageStore, type StoredImage } from './storage/db-image-store';
import {
  baseSeqOf,
  entriesAfter,
  idbJournalBackend,
  type JournalBackend,
  type JournalEntry,
} from './storage/portable-journal';

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
  const els = Array.from(doc.querySelectorAll(IMAGE_SELECTOR));
  if (els.length === 0) return { image: null, failure: null };
  // 読めないほど大きいときの断り文に使う。⚠ 要素を外す前に数える(`textContent` は読まない)
  const embeddedBytes = els.reduce((n, e) => n + embeddedBytesOf(e), 0);
  try {
    /**
     * 🔴 **画像は複数の `<script>` に割って焼いてある**(#1416 §7-4。割る前の版の 1 本物も読める)。
     * 揃っているか(欠け・重複・順の乱れ)を、**中身を読む前に**印だけで見る。
     */
    const broken = checkImageParts(els.map((e) => e.getAttribute('data-pkc-db-image') ?? ''));
    if (broken !== null) {
      return {
        image: null,
        failure: `この HTML ファイルに埋め込まれた中身が読み取れない形になっています(${broken})`,
      };
    }
    // 🔑 1 要素ずつ読み、**読んだ直後に要素を外して中身も空にする**(base64 の文字列を要素ごとに手放す。
    //    外しただけでは、要素が子の Text node を握り続ける)。復号は `decodeImageParts` が 1 本へ直に書く
    const image = decodeImageParts(
      els.map((el) => () => {
        const t = el.textContent ?? '';
        el.textContent = '';
        el.remove();
        return t;
      }),
    );
    return { image, failure: null };
  } catch (e) {
    if (e instanceof RangeError) {
      return {
        image: null,
        failure:
          'この HTML ファイルに埋め込まれた中身が大きすぎて、このブラウザでは読み戻せません' +
          `(約 ${humanBytes(embeddedBytes)})。バックアップ(.pkc3-full.zip など)から取り込んでください`,
      };
    }
    return {
      image: null,
      failure: `この HTML ファイルに埋め込まれた中身が読み取れない形になっています(${errorText(e)})`,
    };
  } finally {
    for (const el of els) el.remove();
  }
}

/** 日誌から「画像のあとに流し直す分」を選ぶ。⚠ 読めなくても投げない(画像だけで開く)。 */
async function readReplay(
  journal: JournalBackend,
  args: { use: ImageChoice['use']; stored: StoredImage | null; exportedAt: number; neverSaved: boolean },
): Promise<{ replay: JournalEntry[]; seqFloor: number; failure: string | null }> {
  const base = baseSeqOf({
    use: args.use,
    snapshotSeq: args.stored?.snapshotSeq,
    savedAt: args.stored?.savedAt,
    exportedAt: args.exportedAt,
    neverSaved: args.neverSaved,
  });
  const imageSeq = args.stored?.snapshotSeq ?? 0;
  try {
    const all = await journal.readAll();
    const seqFloor = Math.max(imageSeq, base ?? 0, ...all.map((e) => e.seq));
    return { replay: base === null ? [] : entriesAfter(all, base), seqFloor, failure: null };
  } catch (e) {
    return { replay: [], seqFloor: Math.max(imageSeq, base ?? 0), failure: errorText(e) };
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
  /**
   * 🔴 **画像のあとに流し直す書込 op**(#1589 の根治 ── `storage/portable-journal.ts`)。
   * 画像に入っていない分だけ、番号順。⚠ 空から始めた回は常に空。
   */
  readonly replay: ReadonlyArray<JournalEntry>;
  /** 日誌の番号の下限(画像の番号と日誌の最大の番号)。⚠ 時計が戻っても番号を増やし続けるため。 */
  readonly seqFloor: number;
  /** 器に 1 度も画像が書かれていない回(昇格時の読み直しで、まだ書かれていなければ同じ土台で流す)。 */
  readonly neverSaved: boolean;
  /** 日誌の器。⚠ 起動後の追記・整理もこれを使う。 */
  readonly journal: JournalBackend;
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
  makeJournal: (dbName: string) => JournalBackend = idbJournalBackend,
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

  const choice0 = withEmbeddedFailure(picked, embeddedFailure);

  const image =
    choice0.use === 'stored' ? (stored?.image ?? null) : choice0.use === 'embedded' ? embedded : null;

  // 器に 1 度も画像が書かれていない(読めなかったのではない)── 空の DB から始めた回の日誌は、空を土台に流してよい
  const neverSaved = stored === null && readError === null;
  const journal = makeJournal(bundleSqliteName(bundle.id));
  const { replay, seqFloor, failure: journalFailure } = await readReplay(journal, {
    use: choice0.use,
    stored,
    exportedAt: bundle.exportedAt,
    neverSaved,
  });
  // 日誌を読めなかったことは黙らない(画像だけで開く)
  const choice: ImageChoice =
    journalFailure === null
      ? choice0
      : { use: choice0.use, why: `${choice0.why}(直前の変更の控えを読めませんでした: ${journalFailure})` };

  return {
    bundle,
    dbName: bundleSqliteName(bundle.id),
    image,
    choice,
    embeddedFailure,
    store,
    replay,
    seqFloor,
    neverSaved,
    journal,
  };
}

/**
 * 🔴 **昇格・待ち明けのタブが開く画像を、器から読み直す**(多重タブ T1)。
 *
 * ⚠ `PortableStart.image` は**起動の 1 回だけ**読んだ物。先に書いていたタブが閉じて別のタブが書き手に
 *   なるとき、それを開き直すと**先のタブの編集を持たない古い画像**で始まり、次の保存が器を上書きして
 *   先のタブの編集が消える(`DbImageStore.write` は put)。
 * 🔑 器を読み直し、**起動の判定(`chooseImage`)と同じ向き**で採る ── 別の PKC3 の記録・空の記録は採らない /
 *   起動で「埋め込みのほうが新しい」と選んだ回は、器が埋め込みより新しい(`savedAt >= exportedAt`)ときだけ採る。
 * ⚠ 読めなかったら**起動の画像へ戻す**(投げない ── 昇格を止めると、いまのノートが保存できなくなる)。
 */
export async function latestPortableImage(
  portable: Pick<PortableStart, 'bundle' | 'image' | 'choice' | 'store'> & { neverSaved?: boolean },
): Promise<Uint8Array | null> {
  return (await latestPick({ neverSaved: false, ...portable })).image;
}

/**
 * 🔴 **昇格・待ち明けで開く「画像 + その後に流し直す日誌」**。⚠ 画像だけ読み直して日誌を起動時のままにすると、
 *   先のタブが足した分が抜け、起動時の日誌を新しい画像へ流して**二重になる** ── 必ず組で読む。
 */
export async function latestPortableStart(
  portable: Pick<PortableStart, 'bundle' | 'image' | 'choice' | 'store' | 'journal' | 'replay' | 'seqFloor' | 'neverSaved'>,
): Promise<{ image: Uint8Array | null; replay: ReadonlyArray<JournalEntry>; seqFloor: number }> {
  const pick = await latestPick(portable);
  const { replay, seqFloor } = await readReplay(portable.journal, {
    use: pick.use,
    stored: pick.stored,
    exportedAt: portable.bundle.exportedAt,
    neverSaved: pick.neverSaved,
  });
  return { image: pick.image, replay, seqFloor: Math.max(seqFloor, portable.seqFloor) };
}

async function latestPick(
  portable: Pick<PortableStart, 'bundle' | 'image' | 'choice' | 'store' | 'neverSaved'>,
): Promise<{ image: Uint8Array | null; use: ImageChoice['use']; stored: StoredImage | null; neverSaved: boolean }> {
  const boot = { image: portable.image, use: portable.choice.use, stored: null, neverSaved: portable.neverSaved };
  try {
    const stored = await portable.store.read();
    if (stored === null || stored.bundleId !== portable.bundle.id || stored.bytes <= 0) return boot;
    if (portable.choice.use === 'embedded' && stored.savedAt < portable.bundle.exportedAt) return boot;
    return { image: stored.image, use: 'stored', stored, neverSaved: false };
  } catch {
    return boot;
  }
}
