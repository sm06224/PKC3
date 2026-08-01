#!/usr/bin/env bash
# Rust core → wasm を出荷物として src 配下へ置く(rust-wasm-strategy §8)。
#
# ⚠ 生成物(.wasm)は **リポジトリに commit する**。理由:
#   - PR gate で cargo を走らせない(CI を長くしない ── user 指示 2026-07-30)
#   - `npm test` / `npm run build` が単独で走る性質を壊さない
#   - 再ビルド漏れは nightly の wasm-parity が検出する
# 同一 rustc(rust-toolchain.toml で pin)なら**同一バイト**になることを確認済み。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=src/adapter/platform/wasm/pkc_core.wasm
cargo build --release --target wasm32-unknown-unknown --manifest-path rust/Cargo.toml
cp rust/target/wasm32-unknown-unknown/release/pkc_core.wasm "$OUT"
echo "built: $OUT ($(stat -c%s "$OUT") bytes)"
