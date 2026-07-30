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

## 残作業(P2)

- [ ] 計測ハーネス移植(boot-rss / storage-write-io / edit-main-thread-block /
      storage-arch-bench + 継続使用の編集セッション腕)
- [ ] PKC2 500MB fixture のベースラインを PKC3 計器で再現取得
- [ ] journal_mode / synchronous / page_size の実測選定(io-bench の型)
- [ ] 実 workload での run-syscall-profile 再計測(A.9 の宿題)
- [ ] 多重タブ: Web Locks writer リース + BroadcastChannel(§4.5)
- [ ] revisions / relations / assets(meta 行)の store op 追加(P4/P5 と接続)
