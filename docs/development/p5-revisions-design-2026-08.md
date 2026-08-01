# P5: revisions ── 設計(2026-08)

正本 doc `pkc3-major-upgrade-design-2026-07.md` §11 の P5。PKC2 実地調査
(2026-07-31、pkc2-surveyor)の結果を踏まえた「流用 + 総合的見直し」。

## 0. PKC2 の実態(調査サマリ)

- **1 操作 = 全文 snapshot 無条件・上限なし**。todo toggle 1 click も textlog
  追記 1 行も全文 1 部。同一内容 skip なし(`content_hash` は field だけ作って
  未使用)。保持ポリシーは設計のみで未実装
- 実測: 合成 fixture で core record の **66.7% が snapshot**。500MB 級では
  revisions 80MB が毎起動 parse され JS heap に常駐(Issue #1041)
- **boot 22.9 秒の 65.5% が revision count の O(N×M)**(bench fixture が
  revisions 0 件で長年隠れていた ──「ゼロ件の次元 = 測っていない次元」の出所)
- trash は独立機構ではなく「entries に居ない lid の revisions」のビュー。
  復元は**前進変異**(復元前に現状を積む。revision は不変・purge 以外で消さない)
- 復元の snapshot parse は厳格契約(不正 JSON / 未知 archetype は null)

## 1. 方針(北極星: 速く、安く、必要十分)

**流用する不変式**(PKC2 で実績のある骨格):

1. **復元 = 前進変異**。rewind しない。復元前に現状を revision として積む
2. **trash = 「entries に居ない entry_lid の最新 revision」ビュー**。独立 trash
   機構を作らない(sqlite では `NOT EXISTS` 1 本で自然に表現できる)
3. 削除は物理削除 + **削除前 snapshot を同 tx で積む**(worker 内で完結)
4. revision は不変。消えるのは「ゴミ箱を空にする」(明示 purge)と保持上限の
   prune だけ

**捨てるもの(丸写し禁止の本丸)**:

1. **「1 操作 = 全文 snapshot 無条件」を捨てる** ── 刻むのは
   **内容が変わった commit と削除だけ**(§2)
2. **上限なしを捨てる** ── 生存 entry は per-entry 最新 N 件(§3)
3. **boot での revision 読込を捨てる** ── boot は revisions に一切触れない。
   件数も一覧も本文も**要求時に SQL で引く**(O(N×M) と 80MB 常駐の直接解)
4. snapshot の JSON 包み(`JSON.stringify(Entry)`)を捨てる ── PKC3 は全 body
   markdown なので **snapshot = body 原文、title / archetype は列**。厳格 parse
   契約そのものが不要になる

## 2. 刻むタイミング

| 操作 | revision | 理由 |
|---|---|---|
| COMMIT_EDIT(body 変更あり) | **積む**(変更前 = baseline を) | undo 点の本体 |
| COMMIT_EDIT(無変更) | 積まない | #1024 系 skip と同じ縁 |
| todo toggle(QUICK 系 splice) | **積まない** | toggle で戻せる・PKC2 堆積の主因。復元価値ゼロ |
| RENAME(title のみ) | **積まない**(v1) | title 履歴は必要十分の外。PKC2 は body 全文込みで積んで肥大した |
| DELETE_ENTRY | **積む**(worker 同 tx で削除直前の行から) | trash の実体 |
| CREATE / import | 積まない | PKC2 と同じ policy(P6 import の扱いは §7) |

- 加えて **content_hash(FNV-1a 64bit)で同一内容 skip** を worker 側で判定
  (直前 revision と一致なら insert しない)。reducer 側の「変更ありのみ emit」
  と二重の防壁
- coalesce(短時間連続編集の置換)は v1 では入れない。**畳む/入れる条件**:
  実運用の revisions 行数・DB サイズを計測し、cap N で不足と数字が出たら入れる

## 3. 保持ポリシー

- 生存 entry: **per-entry 最新 N = 20 件**。超過分は addRevision の同 tx で
  prune(古い順に削除)。定数 `REVISION_KEEP_LATEST`(将来 settings 表へ ──
  移す条件: user が変えたいと言ったとき。flag にはしない)
- 削除済み entry(trash): prune 対象外(生存 entry への書込時にしか prune は
  走らない)。消えるのは「ゴミ箱を空にする」だけ
- 圧縮(zstd)は **v1 では入れない**。判断: 587x の実測は snapshot 群の一括
  圧縮の数字で per-row には効かない + cap N=20 で総量が桁で抑まる見込み。
  **入れる条件**: 実運用計測で revisions が DB サイズの主成分と出たら
  segment 圧縮(seg_id 列は v1 schema から予約済み)を設計する。
  「効果が小さいから棄却」ではなく「測ってから積む」(計測規律)

## 4. schema v2(migration seam の初使用)

```sql
ALTER TABLE revisions ADD COLUMN title TEXT;
ALTER TABLE revisions ADD COLUMN archetype TEXT;
ALTER TABLE revisions ADD COLUMN content_hash TEXT;
-- snapshot(BLOB affinity)には body 原文(markdown)をそのまま入れる
```

- `DB_SCHEMA_VERSION = 2`。applySchema は「新規 DB = 最新 DDL のみ / 既存 DB =
  user_version+1..N の MIGRATIONS を順に適用」。未来 version は従来どおり明示 reject
- PKC2 の bulk_id / prev_rid は v1 では入れない(PKC3 に bulk 操作がまだ無い。
  P6 import で PKC2 の bulk 系譜を持ち込むと決めたときに列を足す)

## 5. worker op(P5a)

| op | 内容 |
|---|---|
| `addRevision { cid, entryLid, title, archetype, body, contentHash, keepLatest }` | 同 tx: 直前 revision の hash 一致なら skip → INSERT(rev_order = MAX+1)→ 超過 prune。`{ added, pruned }` |
| `listRevisionMetas { cid, entryLid }` | id / rev_order / created_at / title のみ(**body は返さない**) |
| `getRevision { cid, id }` | `{ body, title, archetype } \| null`(要求時 1 行) |
| `listTrash { cid }` | entries に居ない entry_lid の最新 revision(meta のみ) |
| `purgeTrash { cid }` | その全 revision を物理削除。`{ purged }` |
| `deleteEntry`(変更) | **revisions を消さない**。同 tx で削除直前の行から trash snapshot を INSERT → relations / entry を削除 |

- ⚠ deleteEntry の意味論変更に伴い、store-probe の
  `countsAfterDelete.revisions === 0` の pin は「削除で trash snapshot が
  1 件増える + purgeTrash で 0 になる」へ書き換える
- ⚠ asset GC(P4b)の keep-set 走査は **revisions 表も対象に加える**
  (worker コメントで pin 済みの義務をこの PR で果たす): trash から復元した
  entry の添付が purge 済み、を防ぐ。scanAssetRefs が entries と revisions の
  両方の body/snapshot を歩く

## 6. app 層(P5b)

- reducer: COMMIT_EDIT の変更ありパスで `REQUEST_REVISION { lid, title,
  archetype, body: baseline }` を追加 emit(store-effects が hash を計算して
  addRevision)。**RETRY_PERSIST は revision を再発行しない**(重複防止は
  hash skip が二重に守る)
- 復元(履歴から): UserAction `RESTORE_REVISION { lid, revId }` →
  store-effects: getRevision → 現 disk body を addRevision(前進変異)→
  persistEntry(revision 内容)→ 既存の ack 経路(BODY_PERSISTED 系)で
  state 更新。editing 中は不可(ready 限定・可視ブロック)
- 復元(trash から): `RESTORE_TRASH { entryLid, revId }` → getRevision →
  CREATE_ENTRY 相当(旧 lid のまま、edit: false)→ persist。lid 衝突
  (同 lid が再作成済み)は可視エラー
- UI: detail toolbar に「履歴」(選択 entry の revision 一覧 → 各行に「復元」)。
  filer root に「ゴミ箱」section(listTrash 一覧 → 「復元」/ 全体に
  「ゴミ箱を空にする」= confirm 付き)。sidebar への count badge は付けない
  (boot で revisions に触れない原則。一覧は開いたときに引く)
- title の限界(記録): RENAME → COMMIT が同時のとき、revision の title は
  rename 後の値になる(body 履歴が本体であり、title の厳密な過去値は
  必要十分の外 ── PKC2 の「rename で body 全文 snapshot」の逆振れはしない)

## 7. 持ち越し(この PR では決めない)

- **P6 import 時の PKC2 revisions の扱い**: PKC2 は replace = 保全 / merge =
  全捨て と非対称。持ち込むなら snapshot 形式の変換(PKC2 Entry JSON →
  body 原文 + 列)も要る。P6 設計時に user へ提示して裁定
- coalesce / zstd segment / bulk_id 系譜: §2 §3 §4 の「入れる条件」に従う

## 8. 着地計画

- **P5a(storage)**: schema v2 + worker op + scanAssetRefs の revisions 対応 +
  store-probe 検定更新。単独で着地・単独で probe 検証可能
- **P5b(app + UI)**: reducer / effects / 履歴・ゴミ箱 UI + smoke 1 拡張
  (削除 → ゴミ箱に見える → 復元 → sidebar に戻る)
