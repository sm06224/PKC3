# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository (PKC3).

## Language Policy

- Internal reasoning MUST be in American English
- Final output MUST be in Japanese

## 会話・提示ルール(user 確立、PKC2 から継承。必ず遵守)

- **AskUserQuestion ツールは使わない**。質問・確認は必ず会話文で行う
- **成果物は GitHub URL(rendered)で提示**。diff の貼り付けでは伝わらない
- **doc-first**: 実装前に設計 doc → GitHub URL で提示 → user 裁定 → 実装
- **意図を読む**: user の発言が事実と食い違っていても、関連する実態を探して会話で聞き返す

## 方針(founding。user 裁定 2026-07-30)

> **北極星: 速く、安く、必要十分、利便性最大。「最強のノートアプリにするんだー」**

- **正本 doc** = `docs/development/pkc3-major-upgrade-design-2026-07.md`(P0 裁定済み・実装 go。
  §12 が裁定記録)。まずこれを読む
- 🚫 **PKC2(sm06224/PKC2)は read-only 参照のみ。手を出さない**(user 指示 2026-07-30)。
  実測・設計の根拠 doc 群は PKC2 側にある(正本 doc §13 にリンク)
- **流用 + 総合的見直し。丸写し禁止**(user 指示 2026-07-30)── 古い設計・積み上げで
  遅くなる実装を持ち込まない。PKC2 はそれで失敗した
- **全 body = PKC-Markdown、アーキタイプ = フレーバー**(見せ方・編集の仕方)。
  JSON 文字列 body を作らない
- **storage**: wasm-sqlite(OPFS SAHPool・専用 worker)+ IDB Blob のハイブリッド。
  ゼロコピー・生成物のライフサイクル終端での即破棄(user 指示 2026-07-27、不可侵)
- **flags は最大 15 個(CI test で pin)+ 各 flag に畳む条件の宣言必須。正規設定(settings)と
  分離する**(user 指示 2026-07-30)
- **新機能を盛り込みすぎない**。将来領域(フォーム→ダッシュボード・帳票 / Graph API・OneNote)は
  正本 doc §10 の拡張点のみ。着手は user の明示 go
- **PKC3 export は PKC2 にインポートしない**(一方通行、user 裁定 2026-07-30)。
  import は PKC2 全形式を受理して新スキーマへ変換
- **計測規律は PKC2 から継承**: boot 窓だけで定常を語らない / 対照群を揃える /
  persistent profile で測る / fixture のゼロ件次元は「測っていない次元」/
  倍率より向き・百分率は分母を書く

## Build & Development Commands

```bash
npm run dev        # Vite dev server
npm run build      # Vite build → dist/(マルチファイル)
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src tests
```

## 段階(正本 doc §11)

P1 bootstrap → P2 計測 + sqlite core → P3 app 層の総合的見直し + リーン集約 →
P4 assets → P5 revisions → P6 import/export → P7 v3.0.0(Pages product + PWA 仕上げ)。
各段階が単独で着地し、単独で計測できる。「効果が小さい」は棄却理由にしない。
