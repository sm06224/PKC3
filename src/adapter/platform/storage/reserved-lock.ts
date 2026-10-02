/**
 * 🔴 **SAHPool の `xCheckReservedLock` を、本当のことを言う関数に差し替える**(#1218 F1)。
 *
 * ## 何が起きていたか
 *
 * 大きな書込(索引の自動片づけ / 取り込みの一括書込 / 全本文の書き換え / VACUUM)の
 * 途中でタブが殺されると、次に開いたとき DB が `quick_check` 失敗や
 * `invalid fts5 file format` で**開けない**。⚠ journal(巻き戻しの記録)は
 * **有効な形のまま残っている** ── 巻き戻されないだけである。
 *
 * 🔴 原因は上流の `opfs-sahpool` VFS の `xCheckReservedLock` が **常に 1**
 * (= 「他の接続が書込の権利を握っている」)を返すこと
 * (`@sqlite.org/sqlite-wasm/dist/index.mjs` の `ioMethods.xCheckReservedLock` の
 * `wasm.poke32(pOut, 1)`)。SQLite は hot journal を見つけても
 * 「書いている最中の他の接続が居る」と読んで巻き戻さない。
 *
 * ## なぜ 0 が正しいか
 *
 * SAHPool は**同期の access handle で排他**なので、同じ file を開ける接続は **1 つだけ**
 * である。「他の接続が握っている」は**起こりえない**。上流の通常の OPFS VFS
 * (`opfs`)は 0 を返している。実測では、これを 0 を返す関数に差し替えた接続で開き直すと、
 * 殺した時点に有効な journal があった組は**すべて**巻き戻って無傷だった
 * (`docs/development/storage-reserved-lock-2026-10.md`)。
 *
 * ## 作り
 *
 * - 差し替えるのは `sqlite3_io_methods` の `$xCheckReservedLock` ── この表は VFS ごとに
 *   **1 枚**で全接続が共有する。だから関数は **wasm ごとに 1 度だけ** install して
 *   使い回す(接続を開き直すたびに増やさない)。
 * - 差し替える前に**いまの関数が 1 を返すか**を 1 度呼んで確かめる。既に 0 を返すなら
 *   上流が直した日なので**差し替えない**(`reservedLockUpstreamFixed`)。
 * - ⚠ **当たらなかったときは黙らない**。`sqlite3_file_control` が失敗した / 表が
 *   取れなかったときは `reservedLockPatched: false` を返し、呼び側が user に言う。
 *
 * ⚠ **pure に近い adapter**(sqlite の口を引数で受ける)── worker から切り出してあるのは、
 *   node の unit で「差し替えが当たらなかった枝」「二度目は install しない」を
 *   見られるようにするため。SAHPool の本物は実ブラウザの probe が見る。
 */

/** `sqlite3` の口のうち、ここで使う部分だけ(上流の型は `any` が多いので自前で切る)。 */
export interface ReservedLockSqlite {
  capi: {
    SQLITE_FCNTL_FILE_POINTER: number;
    sqlite3_file_control(pDb: number, name: string, op: number, pArg: number): number;
    sqlite3_file: new (p: number) => { $pMethods: number };
    sqlite3_io_methods: new (p: number) => { $xCheckReservedLock: number };
  };
  wasm: {
    alloc(n: number): number;
    dealloc(p: number): void;
    peekPtr(p: number): number;
    peek32(p: number): number;
    poke32(p: number, v: number): void;
    installFunction(sig: string, fn: (pFile: number, pRes: number) => number): number;
    functionEntry(p: number): ((pFile: number, pRes: number) => number) | null | undefined;
  };
}

export interface ReservedLockOutcome {
  /** この接続の `xCheckReservedLock` が 0 を返す関数になっている(自前 / 既に差し替え済み)。 */
  reservedLockPatched: boolean;
  /** 上流が既に 0 を返していたので差し替えなかった。 */
  reservedLockUpstreamFixed: boolean;
}

/** wasm ごとに 1 つだけ install した関数の表(wasm が作り直されたら別の関数が要る)。 */
const installed = new WeakMap<object, number>();

/** install した回数(unit が「接続ごとに増やしていない」を見る。本番の判断には使わない)。 */
let installCount = 0;
export function reservedLockInstallCount(): number {
  return installCount;
}

/**
 * 開いたばかりの SAHPool の接続について、`xCheckReservedLock` を 0 を返す関数にする。
 * @param db 開いたばかりの接続(`OpfsSAHPoolDb`)。⚠ `.pointer` はここで読む ── 呼び側に取らせると、
 *   取り違え(0 など)が node の unit に届かない(OPFS が無く、この経路は実ブラウザでしか通らない)
 */
export function fixReservedLock(sqlite3: ReservedLockSqlite, db: { pointer: number }): ReservedLockOutcome {
  const { capi, wasm } = sqlite3;
  const failed: ReservedLockOutcome = { reservedLockPatched: false, reservedLockUpstreamFixed: false };
  let pOut = 0;
  try {
    pOut = wasm.alloc(8);
    const rc = capi.sqlite3_file_control(db.pointer, 'main', capi.SQLITE_FCNTL_FILE_POINTER, pOut);
    if (rc !== 0) return failed;
    const pFile = wasm.peekPtr(pOut);
    if (!pFile) return failed;
    const file = new capi.sqlite3_file(pFile);
    const pMethods = file.$pMethods;
    if (!pMethods) return failed;
    const methods = new capi.sqlite3_io_methods(pMethods);

    const ours = installed.get(wasm);
    // 同じ表を共有する 2 つ目以降の接続 ── もう差し替わっている
    if (ours !== undefined && methods.$xCheckReservedLock === ours) {
      return { reservedLockPatched: true, reservedLockUpstreamFixed: false };
    }

    // 🔑 いまの関数が本当に 1 を返すか、1 度呼んで確かめる(上流が直した日に二重にしない)
    const current = wasm.functionEntry(methods.$xCheckReservedLock);
    // ⚠ 上流は「範囲内で枠が空なら `null`」を返す(`undefined` だけ弾くと `null` を呼んで落ちる)
    if (typeof current !== 'function') return failed;
    wasm.poke32(pOut, 7); // 呼ぶ前の値と区別する
    current(pFile, pOut);
    if (wasm.peek32(pOut) === 0) {
      return { reservedLockPatched: false, reservedLockUpstreamFixed: true };
    }

    let fn = ours;
    if (fn === undefined) {
      fn = wasm.installFunction('i(pp)', (_pFile: number, pRes: number) => {
        wasm.poke32(pRes, 0);
        // 🔴 戻り値の 0 は SQLITE_OK(答えの 0 とは別物)。1 = SQLITE_ERROR は hot journal の検査を失敗にする
        return 0;
      });
      installed.set(wasm, fn);
      installCount++;
    }
    methods.$xCheckReservedLock = fn;
    return { reservedLockPatched: true, reservedLockUpstreamFixed: false };
  } catch {
    /**
     * 🔴 **差し替えの失敗で、保存先を落とさない**。ここから例外が出ると、呼び側(worker の `init`)の
     * OPFS を開く `try` の `catch` が `:memory:` へ退避してしまい、**保存が永続しなくなる**
     * (しかも開いた接続は閉じられない)。当たらなかったことは `failed`(両方 false)で返し、
     * main が「注意」として user に言う。
     */
    return failed;
  } finally {
    try {
      if (pOut) wasm.dealloc(pOut);
    } catch {
      /* 返せなかっただけ ── 8 byte。保存先を落とす理由にならない */
    }
  }
}
