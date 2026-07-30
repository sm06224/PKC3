# P2 storage core ── 作業ログ(2026-07)

設計 doc §11 P2 の進行記録。**結論から書く**。

## 2026-07-30: SAHPool 非 Atomics 成立確認(P2 冒頭 DoD クリア)

**結論: 非 Atomics SAHPool は COOP/COEP なしで成立する。OPFS SAHPool を主経路に確定。**
IDB-VFS は旧ブラウザ / OPFS 不可環境の fallback のみ(設計 doc §4.5 の未確定が解消)。

- 手法: `tests/probe/sahpool-probe.html` + `sahpool-worker.ts`(vite dev 経由で
  `@sqlite.org/sqlite-wasm` 3.53.0-build1 を module Worker に読み込み)を
  headless Chromium(環境同梱 chromium-1194)で実行。runner は
  `tests/probe/run-sahpool-probe.mjs`
- 実測(probe 環境):

```json
{
  "ok": true,
  "steps": {
    "crossOriginIsolated": false,
    "initMs": 146,
    "libVersion": "3.53.0",
    "vfs": "opfs-sahpool",
    "rows": [{ "lid": "e1", "title": "hello" }]
  }
}
```

- `crossOriginIsolated: false` = GitHub Pages / 単一 HTML と同じ「ヘッダ制御なし」条件で、
  `installOpfsSAHPoolVfs` → DB 作成 → INSERT → SELECT の roundtrip が成功
- ⚠ **これは成立確認のみ**。initMs 146ms を含め、性能の数字としては使わない
  (ephemeral context の storage はメモリバックで実 I/O を踏まない ── PKC2 計測規律)。
  性能は P2 の計測ハーネス移植後、persistent profile で測る

## 2026-07-30: schema v1 + storage worker + store client(着地)

**結論: worker 越しの schema v1 が実ブラウザ + OPFS SAHPool で end-to-end 動作。**

- 実装: `src/adapter/platform/storage/`(schema.ts = DDL v1 + フレーバー抽出列 /
  protocol.ts = 型付き message 契約 / storage-worker.ts = sqlite を worker に閉じ込め、
  OPFS 不可は :memory: fallback / store-client.ts = promise 対応の薄い client)
- 検証: `tests/probe/store-probe.html`(headless Chromium)──
  init(vfs: opfs-sahpool)→ upsertEntry(todo は status/date 抽出列つき)→
  **listEntryMetas が body 列を含まない**(O(メタ) 不変条件)→ getBody →
  counts → delete、全 pass
- ⚠ 機能確認のみ。性能はハーネス移植後(下記)

## 2026-07-30: storage core の code review(サブエージェント)と反映

vendor 実装(sqlite-wasm index.mjs)まで読んだ精査で 9 指摘。**同 PR で修正**:
#1 init の silent memory fallback(catch を OPFS 確保に絞る + fallbackReason を
InitResult に載せる + schema 失敗は fallback せず error・接続 close)/
#3 client の worker error 経路(onerror/onmessageerror で pending 全 reject、
terminate 後は即 reject)/ #4 init 冪等化 / #6 typed dispatch table(handler の
返り値型を ResultMap に pin)/ #7 `PRAGMA user_version` seam(未来 version は明示
reject)/ #2 の最小対応(EntryUpsert の抽出列を optional にしない)。

**P3 までに解消(pin)**:

- [ ] **#2 抽出列の一元化**: フレーバー extractor(frontmatter → status/date/archived)を
      唯一の書込経路にして test で pin(二重表現の乖離 = PKC2 #1022 型の予防)
- [ ] **#5 「init 以外は同期」invariant**: handler を async 化するときは client 側の
      直列化(queue)とセットで。それまで pin test を検討
- [ ] **#8 deleteEntry の orphan**: FK + ON DELETE CASCADE か tx 内多表削除
- [ ] **#9 close ≠ SAH 解放**: multi-tab リース設計時の前提として記録

## 2026-07-30: 計器 1「編集セッション腕 + 実書込量」移植・初回スモーク

`tests/bench/edit-session.html` + `run-edit-session.mjs`(persistent profile /
固定ポート 45731 / diskstats 実書込 / RSS 時系列 / nosave 対照群)。
**初回スモーク(entries=1000・edits=30・~1KB 本文)の結果と読み**:

| 項目 | save 腕 | nosave 腕(対照) | 読み(規律どおり「向き」のみ) |
|---|---|---|---|
| seed 1,000 件 | 6,092ms / **実書込 120.8MB** | 6,520ms / 120.7MB | 論理 ~1MB に対し実書込 ~120MB ── **upsert 毎の暗黙 tx による journal 増幅**。A.7 の PKC2 教訓(per-record 増幅)が sqlite でも実測で出た。P2 の journal_mode / tx バッチの実測選定が次の計器 |
| listEntryMetas 1,000 行 | 21ms | ── | body 非読込の O(メタ) が実測でも速い |
| 編集 30 回 | p50 7.4ms / 実書込 3MB | p50 0ms / **0MB** | 書込は保存に帰属(対照群で確認)。1 編集 ~0.1MB は PKC2 既定パスの 1 編集 25.7MB(全量書き)と方向として桁違いに小さいが、**規模もデータも違うため倍率は主張しない** |
| RSS(chromium tree 全体) | ~871MB | ~874MB | GPU/renderer 込みの絶対値なので相対比較専用。長時間セッションの時系列で使う |

⚠ 免責: fixture は revisions / relations / assets **0 件**(測っていない次元)。
smoke 規模(1,000 件)であり PKC2 500MB 級ベースラインではない。diskstats は
ホスト装置全体でノイズ込み ── 腕間比較・向きのみに使う。

## 2026-07-30: journal_mode × tx バッチ掃引 → 既定の採用

計器 1(entries=1000 / edits=30、smoke 規模・向きのみ)で掃引:

| batch | journal(要求→実際) | seed | seed 実書込 | edit p50 | edit 実書込 |
|---|---|---|---|---|---|
| なし | delete→delete | 5,422ms | **120.2MB** | 6.9ms | 3MB |
| 200 | delete→delete | 203ms | **2.3MB** | 7.3ms | 3.5MB |
| **200** | **truncate→truncate** | **177ms** | **2.8MB** | **5.6ms** | **3.2MB** |
| 200 | memory→memory | 158ms | 1.8MB | 2.5ms | 1.6MB |
| 200 | **wal→delete** | 195ms | 2.3MB | 7.2ms | 3.5MB |
| なし | truncate→truncate | 5,080ms | 112.4MB | 6.8ms | 2.8MB |

**結論と採用**:

1. **増幅の主因は upsert 毎の暗黙 tx**(バッチ化で seed の時間・実書込とも ~50 分の 1)。
   `bulkUpsertEntries` を追加し、**大量書込(import / seed)は必ずバッチ経路**を使う
   (P6 import の実装規約として pin)
2. **WAL は SAHPool 非対応**(要求しても delete に落ちる)── 実測で確定、選択肢から除外
3. **既定 journal_mode = truncate** を採用(delete 比でわずかに速く安全性同等)。
   memory は最速だが**クラッシュ時に rollback journal が無く DB 破損リスク** ──
   ノートアプリの既定にしない(A.8 の durability 規律)
4. 編集(単発 tx)の実書込 ~0.1MB/回は journal では動かない ── 将来の掃引軸は
   synchronous / page_size / debounce バッチ(未測定)

## 残作業(P2)

- [ ] 計測ハーネス移植(boot-rss / storage-write-io / edit-main-thread-block /
      storage-arch-bench + 継続使用の編集セッション腕)
- [ ] PKC2 500MB fixture のベースラインを PKC3 計器で再現取得
- [ ] journal_mode / synchronous / page_size の実測選定(io-bench の型)
- [ ] 実 workload での run-syscall-profile 再計測(A.9 の宿題)
- [ ] 多重タブ: Web Locks writer リース + BroadcastChannel(§4.5)
- [ ] revisions / relations / assets(meta 行)の store op 追加(P4/P5 と接続)
