# P6e: 履歴の復元 ── アーカイブが持っている履歴を戻す

> **status**: **着地**(案 C で実装済み)
> **裁定**: user「よくわかんない / **目的に合っていればそれでいいよ**」(2026-08-02)
> ── 方式の判断は Claude に委任。北極星(速く・安く・必要十分)に照らして案 C を採用
> **前提**: P6d 段①〜④ 着地済み(#43 / #44 / #45)

## 0. なぜ今これを書くか

P6d の残件として「アーカイブは履歴の鎖を持つが、復元側がまだ適用しない」と
挙げていた。実装に入る前に読み解いたところ、**残件の理由が想定と違い、
かつ merge 済みのコード(#43)に潜在的な欠陥がある**ことが分かったので、
先に doc にする。

---

## 1. 🔴 見つかった欠陥: `kind` と中身が食い違っている

`writeArchive`(`pkc3-archive.ts`)は履歴 1 行を、こう組み立てている:

| 列 | 出どころ | 実体 |
|---|---|---|
| `kind` | `listRevisionMetas` | **DB に保存されている kind**(`'patch'` / `'full'` / NULL) |
| `snapshot` | `getRevision` | **鎖を tip から遡って復元した全文** |

`getRevision` は要求駆動の materialize 経路(`storage-worker.ts:657`)で、
返るのは**常に全文**である。したがってアーカイブには
**`kind: 'patch'` と書かれた行に全文が入る**。

`kind` を信じてパッチとして適用する読み手はそこで壊れる。いま実害が
出ていないのは `restoreArchive` が履歴を捨てているからで、
**復元を実装した瞬間に踏む**。

### 1-1. 設計 doc の主張と実装のずれ

`p6d-export-design-2026-08.md` §3-1 はこう書いている:

> revisions は**鎖のまま**出す(全文に展開しない)。展開すると N×M の
> バイト数になり、②の常駐設計が台無しになる。

実装は**全版を全文に展開している**。しかも版ごとに tip から遡るので、
鎖の長さ k に対して **O(k²)** の仕事量になる(各版の materialize が
最大 k 段のパッチ適用)。

⚠ **この 2 つは別の問題**である:
- (a) `kind` が中身を表していない = **正しさ**の問題(復元が壊れる)
- (b) 全文展開している = **量**の問題(バイト数と時間)

(a) は必ず直す。(b) は方式の選択。

---

## 2. 方式の選択

### 案 A: 全文のまま出し、`kind` を `'full'` に正す

**変更**: `writeArchive` の `kind: rm.kind ?? 'full'` を `kind: 'full'` にする。

- ✅ 1 行。復元は既存の `importRevisionChains`(`{ body, createdAt }` を受けて
  worker 側で鎖に符号化する)へそのまま流せる ── **新しい書込経路を作らない**
- ✅ codec が 1 つのまま(符号化は worker の中だけ)
- ❌ アーカイブのバイト数が N×M に増える。設計 doc §3-1 の否定した形
- ❌ 書出し時間が O(k²)

### 案 B: 鎖をそのまま出し、そのまま書き戻す

**変更**: worker に「符号化済みの行をそのまま返す op」と「そのまま書く op」を足す。

- ✅ 設計 doc の意図どおり。バイト数も時間も鎖のサイズに比例
- ❌ **移行専用の書込経路が増える**。PKC2 の教訓(CLAUDE.md)──
  「移行専用の書込経路こそが S3 で穴の空いていた場所である」
- ❌ 書き戻しは lid 再採番・id 衝突・既存の鎖との併合を自前で扱う必要がある
  (`importRevisionChains` は「既に鎖を持つ entry には積まない」で回避している)

### 案 C(推す): **鎖のまま出し、worker の中で全文へ戻してから既存経路に流す**

**変更**:
1. `writeArchive` は鎖をそのまま出す(`kind` は**保存形そのもの**なので嘘にならない)
2. 復元は新 op `restoreRevisionChains(chains: 符号化済みの行[])` を足すが、
   その中身は「**decode して states を作り、`importRevisionChains` と同じコードを呼ぶ**」

- ✅ バイト数・書出し時間は鎖に比例(案 B の利点)
- ✅ **書込経路は 1 本のまま**(案 A の利点)── 新 op は decode + 既存関数の呼び出し
- ✅ codec が 1 つ。`encodeReverse` / `materialize` と同じ module の中で完結するので、
  読み側と書き側がずれようがない
- ⚠ decode → encode を往復するので、**元と同じ符号化になるとは限らない**
  (`keepLatest` の刈り込み・無変更版の畳み込みが再適用される)。
  これは**仕様として受ける** ── 復元は「同じ状態列が戻る」ことを保証し、
  「同じバイト列が戻る」ことは保証しない

---

## 3. 検証の形

🔑 **「同じ状態列が戻る」を assert する**。バイト列の一致ではない。

1. 履歴を持つ container を作る(版を k 個)
2. アーカイブに書き出す
3. 別 cid へ復元する
4. **両方の全版を materialize して**、`(rev_order, body)` の列が一致することを見る

⚠ 片側だけを materialize して比べてはいけない ── 符号化の差を状態の差と
取り違える。

⚠ **旧アーカイブの互換**: 案 C へ移ると、既に書き出した `.pkc3.zip`(全文 +
嘘の `kind`)が世に出ている。読み側は `kind` を見て分岐するので、
**旧アーカイブは全文として読めてしまい、`kind: 'patch'` の行をパッチとして
適用しようとする**。→ manifest の `version` を上げ、旧 version は
「全文として読む」経路へ倒す。この分岐は test で pin する。

---

## 4. 段取り

| 段 | 内容 |
|---|---|
| ① | **`kind` の嘘を止める**(単独で着地。案 A 相当の最小修正 + version 付け) |
| ② | 鎖をそのまま出す op + 書出し側の切り替え |
| ③ | `restoreRevisionChains`(decode → 既存経路)+ 復元の結線 |
| ④ | 状態列の round-trip test / 旧アーカイブの互換 test |

①だけでも「復元を実装したら壊れる」状態は解消する。②③は量の改善なので、
「効果が小さいからやらない」ではなく**積む**(user 指示 2026-07-27)。

---

## 5. 着地したもの(2026-08-02)

| 段 | 実体 |
|---|---|
| ① | `ARCHIVE_VERSION` を 2 へ。読み側は **1〜2** を受け、**v1 は `kind` を `'full'` へ正規化**(v1 の kind は嘘なので、そのまま渡すとパッチとして適用されて壊れる) |
| ② | worker に `exportRevisionChain`(**materialize しない**)。`ArchiveSource` から `listRevisionMetas` / `getRevision` を外し、`getRevisionChain` 1 本にした ── **型の上で「全文へ復元してから書く」ができない**形にする |
| ③ | worker に `restoreRevisionChains`。中身は **decode → `writeChain`**。`importRevisionChains` の本体を `writeChain` として切り出し、**取込も復元も同じ関数を通る**ようにした(書込経路は 1 本のまま) |
| ④ | `restoreArchive` が鎖を返す(lid 写像 / rev_order 降順 / entry の無い版は件数を言う)。復元の test file を新設(**それまで復元には test が 1 件も無かった**) |

### 検証で分かったこと

🔴 **既存の「履歴は鎖のまま往復する」test は、壊れた実装でも通っていた。**
fake の `getRevision` が保存形をそのまま返しており、**stub が本物より正しかった**
(本物の worker は materialize する)。`getRevisionChain` 1 本にしたことで、
この食い違いは**構造的に起こらなく**なった ── 書出しは materialize 経路に触れない。

🔴 **smoke の fixture が「パッチ行ゼロ」だった。**
本文が短いと `encodeReverse` が「パッチ > 全文」と判断して全行 `kind: 'full'` になり、
**逆向きパッチの経路を 1 度も通らない**。実際、パッチ行の中身を壊す変異が最初は
素通りした。本文を 40 行に伸ばし版を 2 つにして、初めて捕まるようになった
(「fixture のゼロ件の次元は測っていない次元」)。

### 保証範囲

「**同じ状態列**が戻る」。同じバイト列は保証しない ── decode → encode を往復するので、
`keepLatest` の刈り込みと無変更版の畳み込みが再適用される。

### 残る限界

- **ゴミ箱の版(entry が居ない履歴)は復元しない** ── 鎖の起点 = tip が無く decode
  できない。件数は言う
- **パッチの中の asset key は書き換えられない**(差分を書き換えると壊れる)。
  PKC3 の key は content hash なので通常は写像が恒等になる ── 恒等でなかった件数を言う

## 6. 参照

- `p6d-export-design-2026-08.md` §3-1(鎖のまま出す方針)
- `p5c-revision-delta-design-2026-08.md`(逆向きパッチの設計)
- `src/adapter/platform/storage/storage-worker.ts` — `encodeReverse` / `materialize` /
  `getRevision` / `importRevisionChains`
