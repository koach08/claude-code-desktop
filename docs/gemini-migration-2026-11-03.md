# 補助 API サーバーの Gemini 更新

対象は Ariya Bridge の `api-server/`。ターミナルで動かす Gemini CLI の更新とは別。
基準 commit: `4925497e861087682b471d797ac329cc0f92e86e`。

- 既定を `gemini-3.5-flash-lite`、上位の選択肢を `gemini-3.8-flash` に変更。
- 保存済み 2.5 Flash/Pro の選択は、それぞれ上記モデルへ読み替える。2.5 Flash-Lite は対象外。
- 3 系以降へ temperature を送らず、最後が空でない user ターンになることを確認。2 系の明示指定は既存の prefill を維持する。空の最終入力で過去の質問を再送しない。
- 表示する応答は全テキスト part から集め、thought と表示された part は含めない。
- API キーを URL ではなく同じ Google API のヘッダーに渡す。
- 他プロバイダーや音声機能、ターミナルの CLI は変更しない。

検証: `node --test test/gemini-compat.test.js`、対象 JS の `node --check`。10 件の外部通信なしテストが成功。

未検証: 実際の API サーバーが現在使われているか、実キーのアクセス/利用枠/料金、Electron からの日本語・長文・連続会話、実際の SSE、応答速度、旧 Pro と新 Flash の品質差。全アプリのビルドや既存テスト全件は実行していない。

この API サーバーは現在、テキストの履歴だけを再構築する方式。tool/function calling や任意の Gemini part をサポートするものではない。新しく高度な会話機能を足すなら、thought signature を含む履歴保存または Interactions API のサーバー側継続を別の変更で実装・検証する必要がある。今回の局所変更だけで高度な会話互換性を保証しない。

公開前は日本語/英語、長文、3往復以上の会話、キャンセルと再送、エラー時の画面表示、指定した最大トークン数で答えが切れないことを確認する。main マージ・本番配備・有料 API 呼出はこの作業ではしていない。

公式資料:
- https://ai.google.dev/gemini-api/docs/deprecations
- https://aistudio.google.com/docs/whats-new-gemini-3.6
- https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8
