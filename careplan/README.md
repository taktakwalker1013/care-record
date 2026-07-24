# ケアプラン原案 生成パイプライン（プロトタイプ）

介護記録アプリ（`care-record`）の発想を **ケアプラン作成支援** に転用した、分業型の縦串プロトタイプです。
「一枚岩で全部やらせる」のではなく、工程ごとに **エージェント／スキル／コード** を役割で使い分け、
中間表現（JSON）で受け渡して束ねます。

> ⚠️ 本パイプラインが作るのは **原案（たたき台）** です。ケアプランは介護支援専門員が作成・確定・交付する
> 法定文書であり、最終責任はケアマネジャーにあります。要配慮個人情報を扱うため、実利用者データは
> 事業所規程に従って取り扱い、リポジトリにはコミットしないでください（本リポジトリの `fixtures/` は
> すべて **架空事例** です）。

## 設計の要点：性質で実装を分ける

| 工程 | 性質 | 実装 | 理由 |
|---|---|---|---|
| 読取 | 決定論・無損失 | **コード**（`skills/parse_assessment.mjs`） | 事実を改変しない |
| 型判定・ニーズ抽出・原案作成 | 判断・生成 | **エージェント**（`agents/*.md`） | 解釈が要る |
| 字数調整 | 半決定論 | **エージェント⇄カウンタ**（`skills/count_chars.mjs`） | 生成はLLM、合否判定はコード |
| 検証 | 判断 | **エージェント**（`agents/05_verify.md`） | 根拠照合・ハルシネーション検出 |
| 転記 | 決定論・無損失 | **コード**（`skills/transcribe.mjs`） | 確定文言を一字も書き換えない |

**転記をLLMに通さない** のが肝です。確定した値を帳票へ写す作業は、コードで無損失に行うことで、
根拠のない記述が最終帳票へ混入するのを防ぎます。

## データフロー（中間表現で疎結合）

```
01〜07_*.md ─[読取:コード]→ assessment.json（事実・無損失）
      ├─[型判定:AI]────────→ plan_type
      ├─[ニーズ抽出:AI]─────→ needs.json（各ニーズに根拠必須）
      ├─[原案作成:AI]───────→ draft（第1表/第2表/第3表・字数自由）
      ├─[字数調整:AI⇄カウンタ]→ fitted（各セル上限内）
      ├─[検証:AI]───────────→ verify（根拠照合・要確認事項）
      └─[転記:コード]────────→ careplan.md（帳票・fail-closed）
```

各段は入力・出力スキーマ（`schemas/`）だけ守れば独立に差し替え・改良できます。

## ディレクトリ

```
careplan/
  schemas/       中間表現のJSON Schema と 帳票セル文字数上限(cell_limits.json)
  skills/        決定論スキル（読取・文字数カウント・転記）＋ 共通mdパーサ
  agents/        判断工程のエージェント契約（プロンプト＋入出力スキーマ）
  orchestrator.mjs  縦串を束ねる実行スクリプト（エージェント実行器は差し替え可能）
  skills/llm_agent.mjs  実LLM実行器（Claude Messages API・emitツールで構造化出力）
  fixtures/      架空事例と生成デモ出力（fixtures/out）
```

## 実行（架空事例デモ）

```bash
node careplan/orchestrator.mjs \
  --in careplan/fixtures/sample_assessment.md \
  --captured careplan/fixtures/captured \
  --out careplan/fixtures/out
```

`fixtures/captured/` は各エージェント段の出力を捕捉したもの（オフライン再現用）。

## 実行（実LLM接続）

`--llm` で `replayAgent` を実LLM実行器（`skills/llm_agent.mjs`）に差し替えます。
各エージェント段は「システム＝`agents/<name>.md` の契約」「ユーザー＝入力JSON」で Claude を呼び、
`emit` ツール（`tool_choice` で強制）＋各段の出力スキーマで構造化出力を受け取ります。

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # または OAuth の場合 ANTHROPIC_AUTH_TOKEN
node careplan/orchestrator.mjs --llm \
  --in 01_basic_info.md,03_assessment.md \
  --out out --model claude-opus-4-8
```

読取・字数カウント・転記は決定論のまま（コード）。判断5段のみ LLM が担います。
キー未設定時は決定論の読取まで実行し、最初のエージェント段で明示エラーを出して停止します。

各スキルは単体でも動きます:

```bash
node careplan/skills/parse_assessment.mjs 01.md 03.md > assessment.json
node careplan/skills/count_chars.mjs draft.json          # 超過があれば exit 1
node careplan/skills/transcribe.mjs draft.json           # 超過セルがあれば転記中断
```

## 検証済みの範囲

- 架空事例で 読取→型判定→ニーズ抽出→原案→字数調整（超過セルの圧縮ループ）→検証→転記 が通ることを確認。
- 仮名化済みの実アセスメント素材（課題分析標準項目1〜23）でも読取スキルが機能することを確認
  （診断・身体測定・ADL/IADL・自立度・現利用サービス・強み/課題/優先領域・意向を抽出）。
  実素材の表記ゆれ（見出しの異体字、箇条書きの自立度など）にも耐えるよう調整済み。
- `cell_limits.json` を **記入済みの実計画書2名分の各セル実測値** で較正（`_calibration` に実測最大値を記録）。
  総合的な援助の方針は実測393字に対し上限450字、課題分析の結果欄（実測283字）も追加した。

## 未実装・今後

- 型テンプレート（type1A/1B/2A の制度知識）をLLM呼び出しに同梱（現状はassessmentのみ渡す）。
- 第3表（週間サービス計画表）の自動展開。
- 第2表の「※1保険給付の区分（〇）」列の反映。
- 個人情報の取り扱い経路（匿名化・権限）の設計。
