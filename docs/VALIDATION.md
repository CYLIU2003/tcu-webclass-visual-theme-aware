# v0.3.0 検証記録

> これは2026-07-30時点の拡張機能・既存時間割スナップショットに対する履歴記録です。2026年秋に教学課が公開した時間割への適合や現行データの正確性を保証しません。科目データの品質状態は [`COURSE_CATALOG_QUALITY_AUDIT_2026.md`](COURSE_CATALOG_QUALITY_AUDIT_2026.md) を参照してください。

検証日: 2026-07-30

## 検証対象

- Manifest V3拡張機能本体
- 2026年度全学部・全研究科時間割データ
- 提供されたWebClassコースリストHTMLを匿名化したDOMスナップショット
- Chrome/Edge相当のChromium描画

## 静的検証

| 項目 | 結果 |
|---|---|
| Manifest V3 | OK |
| 対象ホスト `https://webclass.tcu.ac.jp/*` のみ | OK |
| 拡張機能バージョン 0.3.0 | OK |
| JSON構文 | OK |
| JavaScript構文 | OK |
| 2,556講義コードの一意性 | OK |
| PDF上5,569掲載・107ページ・5資料との整合 | OK |
| 通常時限・共同原子力専攻時限 | OK |
| 科目名正規化4ケース | OK |
| 個人名・実セッショントークンのプレビュー残存 | なし |

実行コマンド:

```bash
python tests/validate.py
node tests/test_normalization.mjs
node --check src/content.js
node --check src/popup.js
node --check src/options.js
```

## 実HTML統合テスト

`tests/test_live_dom.py` により、匿名化済み実HTMLスナップショットへ拡張機能を適用して確認しました。

| 項目 | 結果 |
|---|---|
| `#schedule-table` の既存表を直接カード化 | OK |
| 8履修科目・12時間割セルを処理 | OK |
| パワーエレクトロニクス特論: 12K / 鈴木 憲吏 | OK |
| 電力システム工学特論: 12J / 中島 達人 | OK |
| 情報理論特論: 12A / 新家 稔央 | OK |
| 新着・締切状態の保持 | OK |
| 左側表示オプションの生成 | OK |
| 独立補助時間割が初期状態で非表示 | OK |
| 無関係なDOM追加後もカード重複なし | OK |
| カード表示OFFで元HTMLへ復元 | OK |
| 再度ONでカード表示を再適用 | OK |
| その他のコース補助情報を個別OFF | OK |
| 紫・青・緑テーマ色への追従 | OK |

実行コマンド:

```bash
python tests/test_live_dom.py
```

## 未実施・制約

- 認証済みWebClass本番環境へ直接ログインしたE2E試験は行っていません。
- 提供されたHTML時点のDOM構造に基づく検証です。WebClass側の更新で要素名・階層が変わった場合はセレクター調整が必要です。
- 2026年度時間割PDFはスナップショットです。休講、教室変更、担当変更、オンライン切替はWebClass上の正式なお知らせを優先します。
