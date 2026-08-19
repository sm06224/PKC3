/**
 * 🔴 **旧ビルドの本体タブでも起動を止めない**(#286。2026-08-19 に実機で踏んだ)。
 *
 * ## 何が起きたか
 *
 * #260 で boot が `resolveContainer` を**無条件で呼ぶ**ようにしたところ、
 * **起動が丸ごと失敗**した ── 画面に出たのは `未知の op です: resolveContainer`。
 *
 * 原因は多重タブである。PKC3 は本体(holder)1 枚が worker を持ち、
 * 2 枚目以降(follower)は**本体経由**で store を叩く(`store-proxy.ts`)。
 * ⚠ そして **本体が旧ビルドのことがある** ── 版が配られても、
 * 読み直したタブだけが新しくなる(`sw/update-prompt.ts`)。
 * このとき新しい follower が投げる新しい op を、**旧ビルドの worker は知らない**。
 *
 * 🔑 `schema.ts` に「**旧ビルドのタブが本体のことがある**」と書いてあり、
 * `store-effects.ts` にも「**落ち方は『機能が減る』でなければならない**」と
 * 書いてあった。どちらも読んでいたのに、**起動の経路にだけ**その規律を
 * 通していなかった ── 機能が 1 つ減るのではなく、**アプリが開かなくなった**。
 *
 * ## 規律(次に op を足す人へ)
 *
 * 🔴 **boot が呼ぶ op は、旧ビルドの本体に断られても進めなければならない。**
 * 新しい op は「あれば使う」であって「無ければ死ぬ」ではない。
 * ⚠ ただし**何でも握りつぶさない** ── 「知らない op」以外の失敗は
 * そのまま投げる(下記)。
 */

/**
 * 旧ビルドが使っていた器の id。
 *
 * ⚠ **定数に戻したわけではない**(#260 の不具合はこれが全インストール共通
 * だったこと)。ここは「**旧ビルドの本体に合わせるときだけ**使う綴り」であり、
 * 旧ビルドは必ずこれを使っていたので、**その本体が持っているデータの区画**は
 * これで正しい。
 */
export const LEGACY_CID = 'default';

/**
 * 「その op を知らない」という断りか。
 *
 * ⚠ **握りつぶす範囲を狭くする。** ここを広く取ると、worker が生きているのに
 * 一時的に失敗しただけの回まで旧 id へ落ちる ── 採番済みの端末では
 * **空の器を開いて「データが消えた」ように見える**(いちばん怖い誤り)。
 *
 * 🔑 見るのは 2 形だけ:
 * - `未知の op です: …` ── いまの worker が名指しで断る形(`storage-worker.ts`)
 * - `handler is not a function` ── 名指しの門が入る前のビルドが出す形
 */
export function isUnknownOpError(err: unknown): boolean {
  const s = String(err);
  return s.includes('未知の op') || s.includes('is not a function');
}

/** boot が要る 2 つの口だけを受ける(protocol 型をここへ持ち込まない)。 */
export interface ContainerPorts {
  /** 新しい本体だけが答えられる。 */
  resolveContainer(title: string): Promise<{ cid: string }>;
  /** 旧ビルドも答えられる(`openContainer`)。 */
  openLegacyContainer(cid: string, title: string): Promise<void>;
}

export interface ResolvedContainer {
  cid: string;
  /** 旧ビルドの本体に合わせた回。⚠ 呼び側はこれを**画面に出す**(黙って劣化しない)。 */
  legacy: boolean;
}

/**
 * この端末の器を決める。**新しい本体なら採番済みの id、旧ビルドの本体なら旧 id。**
 *
 * ⚠ 旧 id へ落ちるのは「知らない op」と断られたときだけ。それ以外は投げる ──
 * 本当の失敗を握りつぶすと、採番済みの端末が**空の器**を開く。
 */
export async function resolveContainerCompat(
  ports: ContainerPorts,
  title: string,
): Promise<ResolvedContainer> {
  try {
    const { cid } = await ports.resolveContainer(title);
    return { cid, legacy: false };
  } catch (err) {
    if (!isUnknownOpError(err)) throw err;
    // ⚠ 旧ビルドの本体は `openContainer` を知っている(この op は残してある)
    await ports.openLegacyContainer(LEGACY_CID, title);
    return { cid: LEGACY_CID, legacy: true };
  }
}

/**
 * 旧ビルドの本体に合わせた回に画面へ出す断り。
 * ⚠ **黙って劣化しない** ── user から見ると「別のタブを閉じるまで直らない」ので、
 * 何をすれば直るかまで書く。
 */
export const LEGACY_HOST_NOTICE =
  '古い版のタブが本体になっています。すべてのタブを閉じてから開き直すと、新しい版で動きます';
