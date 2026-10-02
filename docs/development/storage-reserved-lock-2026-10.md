# 殺された書込が開けなくなる件の直し ── `xCheckReservedLock` の差し替え(#1218 F1)

**状態:🟢 実装 + 実測の記録**(2026-10-02)。画面の字は 1 行だけ足した(下の「画面に出る字」)。
直したのは `src/adapter/platform/storage/reserved-lock.ts`(新設)と `storage-worker.ts` の `init`。

## 何が起きていたか(user の身に起きること)

大きな書込(索引の自動片づけ / 取り込みの一括書込 / 全本文の書き換え / VACUUM)の途中でタブが殺されると、
**次に開いたとき DB が開けない**(`quick_check` の失敗 / `invalid fts5 file format`)。
user には「ノートが開けない」と見える。⚠ 殺される場面は、バッテリー切れ・ブラウザの強制終了・OS による
タブの破棄など、**user が選べない**もの。

## 原因

SQLite は書込の前に「巻き戻しの記録(journal)」を残す。殺されたあとの次の open で、journal が
残っていれば巻き戻す ── ただし**「他の接続が書いている最中ではない」ときだけ**。それを
VFS の `xCheckReservedLock` に尋ねる。

🔴 `@sqlite.org/sqlite-wasm` の `opfs-sahpool` はこれに**常に 1(= 他の接続が握っている)**を返す
(`dist/index.mjs` の `ioMethods.xCheckReservedLock` の `wasm.poke32(pOut, 1)`)。だから SQLite は
**有効な journal を見つけても巻き戻さない** ── 書きかけの変更がそのまま見え、b 木が食い違う。
journal 自体は有効な形で残っている(調査で確認)。

## 直し

その接続の `xCheckReservedLock` を **0 を返す関数に差し替える**(`fixReservedLock`)。

- **0 が正しい理由**:SAHPool は同期の access handle で排他なので、同じ file を開ける接続は 1 つだけ。
  「他が握っている」は起きえない。上流の通常の OPFS VFS(`opfs`)は 0 を返している。
- 関数は wasm ごとに **1 度だけ** install して使い回す(io_methods の表は VFS ごとに 1 枚で全接続が共有する)。
- 差し替える前に**いまの関数が 1 を返すか**を 1 度呼んで確かめ、既に 0 なら差し替えない
  (上流が直した日に二重にならない)。
- ⚠ **当たらなかったとき黙らない**:`init` の返事に `reservedLockPatched` /
  `reservedLockUpstreamFixed` を載せ、両方 false(かつ OPFS で開けた回)なら main が「注意」として
  メッセージに積み、画面下の 1 行にも出す(`reservedLockCaution`)。

### 画面に出る字(当たらなかった回だけ)

> 書き込みの途中でタブが閉じたときに元へ戻す仕組みが、このブラウザでは働いていません ── 大きな取り込みや片づけの最中は、タブを閉じないでください

`ui-terms.ts` の使わない語を含まないことを test が見る。

## 実測(2026-10-02。フル Chromium 141、この箱、OPFS SAHPool、journal は既定の `truncate`)

条件:本文 8KB のノートを file 約 200 MiB(8,668 件)まで足した DB で、
**全ノートの本文を書き換える大きな 1 トランザクション**(`UPDATE entries SET body = body || ' '`)を投げっぱなしにし、
指定の ms 後に renderer を `SIGKILL` → 同じ profile で開き直す(`storage-gauge-probe.mjs` の phase `h`)。

| 殺す時点(更新の開始から) | 差し替え有り(製品) | 差し替え無し(対照群) |
|---|---|---|
| 1,500 ms | 開ける / `quick_check` ok / 変更行 **0** | 開けるが **`quick_check` 失敗**(Freelist / Rowid out of order)/ 変更行 **179**(途中の状態が見える)|
| 3,000 ms | 開ける / ok / 変更行 **0** | **失敗**(Tree 26 の page 番号が不正)/ 変更行 **321** |
| 4,500 ms | 開ける / ok / 変更行 **0** | **失敗** / 変更行 **991** |

- 総ノート数は 8,668(どの回も)。差し替え有りの 3 回は `reservedLockPatched: true` /
  `reservedLockUpstreamFixed: false` ── つまり**上流はいまも 1 を返している**(この版の `@sqlite.org/sqlite-wasm`)。
- 対照群は `reserved-lock.ts` の `fixReservedLock` を「当てずに返す」形へ**手で書き換えた build**
  (変異 M1)。製品に切り替える口は足していない(flag を増やさない)。
- 補足(1 回ずつ):100 MiB で 1,500 ms の殺しも差し替え有りは巻き戻った。
  **VACUUM** の途中(`VACUUM` の 20% / 50% / 70% 地点 = 500 / 1,250 / 1,750 ms)を 200 MiB で殺しても、
  差し替え有りは 3 回とも `quick_check` ok・殺す前と同じ file の状態で、その後の VACUUM も最後まで通った。
- 調査(別の担当)の記録として、更新 3 点 + VACUUM 4 点の 7/7 が巻き戻った、という実測を受け取っている
  (製品の `init` を通した版)。⚠ そちらは**この表の測り方とは別の回**で、数字は上の表と混ぜていない。

## 分からなかったこと(正直に)

- **Safari / Firefox / iOS** は測っていない(この箱は Chromium だけ)。`sqlite3_file_control` の
  `SQLITE_FCNTL_FILE_POINTER` は VFS の中の話なのでブラウザ差は無いはずだが、**未確認**。
- 殺す時点は**更新が走っている最中の 3 点**だけ。journal がまだ無い瞬間・journal を消す瞬間
  (truncate の直前直後)は狙っていない。そこで殺された回は、差し替えの有無に関わらず
  「巻き戻す物が無い / 既に終わっている」ので、この直しの守備範囲ではない。
- journal モードは既定(`truncate`)だけ。`delete` / `persist` は測っていない(製品は allowlist で選べる)。
- 差し替えは**この VFS の全接続に効く**(表が共有)。`guest`(客の DB)も同じ VFS を使うなら
  同じく 0 を返すが、客の DB を殺して開き直す回は測っていない。
- 上流がいつ直すかは分からない。直った日は `reservedLockUpstreamFixed: true` になり、差し替えは外れる。
- **VACUUM を自動で打つかは別の裁定**(`src/features/storage/auto-optimize.ts` の冒頭)。
  この直しは原因を塞いだ事実であって、VACUUM の自動化の許可ではない。

## 守っている test(と、守っていない物)

- `tests/adapter/reserved-lock.test.ts` ── 差し替わる / 2 本目の接続は install しない /
  上流が 0 なら差し替えない / 当たらなかった 3 通り + 引けない 1 通りは**両方 false**(fake の SQLite 口)。
- `tests/adapter/storage-worker.test.ts` ── `OpfsSAHPoolDb` を作る箇所が `storage/` に 1 つだけ(原文走査)/
  差し替えが「開いた直後・`applySchema` より前」/ `init` の返事に載る(`:memory:` では両方 false)。
- `tests/adapter/caution-events.test.ts` ── 言う条件の真理値表 + main の配線(原文)+ 使わない語。
- `tests/adapter/probe-storage-gauge-judge.test.ts` ── 殺す probe の判定規則(5 つの結末 / 対照群の成立条件)。
- 守っていない物:**本物の SAHPool での巻き戻しは unit では見えない**(node に OPFS が無い)── 上の実測が見る。
  その probe は **CI では回さない**(手動。`npm run build` もいらず `vite` の dev で回せる)。
  回し方:`node tests/probe/storage-gauge-probe.mjs --port=<port> --phases=h --hsize=200`
  (対照群は `reserved-lock.ts` を手で書き換えて `--hexpect=unpatched`)。
- 変異試験(2026-10-02、9 件):M1 差し替えを外す / M2 rc ≠ 0 でも patched を返す / M3 `OpfsSAHPoolDb` を
  2 か所目に書く / M4 関数を接続ごとに install / M5 差し替えを `applySchema` の後へ回す / M6 返事に載せ忘れる /
  M7 上流が 0 でも差し替える / M8 main が積まない / M9 差し替え済みでも言う ── **全部 KILLED**。
  M1 は実ブラウザでも壊れた(上の対照群)。
