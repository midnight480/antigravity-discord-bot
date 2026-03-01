# Changelog

## v1.3.0 (2026-03-02)

### 新機能
- **承認ボタンの動的ラベル**: Discord上のボタンがAntigravity側のボタン名（Run, Allow Once等）をそのまま反映するようになりました
- **破壊的コマンドのブロック（Smart Safety）**: 自動承認モードでも `rm -rf /` 等の危険なコマンドはDiscordに通知して手動承認を要求します
- **セキュリティガード**: `DISCORD_ALLOWED_USER_ID` が未設定の場合、ボットが起動を拒否するようになりました

### 改善
- **iframe走査の廃止**: チャットパネルがメインdocument上にあることが判明したため、不要なiframe走査を全廃。3関数（`getTargetDocs`, `findAgentFrame`, 旧`fillEditor`等のdocパラメータ）を削除
- **レスポンス抽出の簡素化**: 264行のスクロール＋ブロック解析ロジックを約120行に削減。5段テキスト処理パイプラインを廃止し、DOM直接参照方式に変更
- **承認処理の簡素化**: outerHTML解析→span.truncateの直接参照に変更。Safe Click（兄弟ボタン検証）を採用
- **品質判定の廃止**: `isLowConfidenceResponse` による判定を削除し、シンプルなテキスト返却に一本化

### 変更されたファイル
| ファイル | 主な変更 |
|---|---|
| `discord_bot.js` | セキュリティガード、iframe走査廃止、承認処理簡素化、動的ラベル、Smart Safety、レスポンス抽出再設計 |
| `selectors.js` | 承認キーワード10種に整理、`DANGEROUS_COMMANDS` パターン追加 |
| `.gitignore` | 診断用一時ファイルを除外対象に追加 |

---

## v1.2.0

### 新機能
- 自動承認モード (`/auto on/off`)
- 各種スラッシュコマンド (`/model`, `/mode`, `/title`, `/newchat`, `/stop`, `/screenshot`)
- ファイル監視機能

---

## v1.1.0

### 新機能
- `DISCORD_ALLOWED_USER_ID` によるアクセス制限
- 基本的なCDP接続とメッセージ送受信

---

## v1.0.0

### 初期リリース
- Discord ↔ Antigravity間の基本的なメッセージ中継
- CDP経由でのテキスト注入・生成監視
