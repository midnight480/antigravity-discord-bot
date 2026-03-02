<div align="center">

![Header Image](header.jpg)

# Antigravity Discord Bot


<img src="https://img.shields.io/badge/Node.js-18.x+-43853D?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
<img src="https://img.shields.io/badge/Discord.js-14.x-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord.js" />
<img src="https://img.shields.io/badge/WebSocket-WS-000000?style=for-the-badge" alt="WebSocket" />
<img src="https://img.shields.io/badge/Chokidar-5.x-blue?style=for-the-badge" alt="Chokidar" />

</div>

このツールはAntigravity (VS Code Fork) を Discord から操作するためのボットです。
Chrome DevTools Protocol (CDP) を使用して Antigravity の内部状態にアクセスし、メッセージの送信や操作の自動化を行います。
> ※ 本ツールは公式のAntigravityとは無関係の非公式ツールです。

> [!CAUTION]
> **【重要】セキュリティに関する警告 / Security Warning**
> 
> このソフトウェアは **「開発者向けの実験的ツール (Proof of Concept)」** です。
> 仕組み上、**あなたのPCを外部（Discord）から遠隔操作するバックドア** として機能します。
> 
> - **リスク**: 設定 (`DISCORD_ALLOWED_USER_ID`) を誤ったり、Botトークンが漏洩した場合、**PC内のファイルを削除されたり、悪意のあるコマンドを実行されたりする** 危険性があります。
> - **免責事項**: このソフトウェアを使用した結果生じた損害（データの損失、PCの不具合、セキュリティ被害など）について、作者は一切の責任を負いません。**セキュリティリスクを十分に理解した上で、自己責任で使用してください。**
> - **非推奨**: セキュリティの知識がない一般ユーザーへの配布や、不特定多数が閲覧できる場所へのトークン公開は絶対に行わないでください。


## ⚠️ セキュリティについて (必読)

このBotは、あなたのPC上で動作しているAIエージェントをDiscordから操作可能にします。AIエージェントは「ファイルの読み書き」や「コマンド実行」の権限を持っているため、**Botの操作権限を奪われることは、PCの乗っ取りと同義です。**

**安全に使うための絶対ルール:**
1.  **`.env` ファイルを絶対に公開しない**: `DISCORD_BOT_TOKEN` はパスワードと同じです。
2.  **`DISCORD_ALLOWED_USER_ID` を正しく設定する**: 許可するユーザーIDを自分だけに限定してください。この設定を空にしたり、間違えたりしないでください（v1.1以降、未設定では起動しません）。
3.  **信頼できるネットワークで使用する**: 公衆無線LANなど、盗聴の危険がある場所での使用は避けてください。
4.  **独立した環境で使用する**: 万が一の事故に備え、普段使いのメインPCではなく、**個人情報が含まれていない（または初期化しても問題ない）独立したPCや仮想環境** での利用を強く推奨します。

## おすすめの導入方法

antigravityのAIチャットに以下のプロンプトを入力してください。
「https://github.com/harunamitrader/antigravity-discord-bot を導入して。可能な範囲でAI側で作業を行い、必要な情報があれば質問して。手動で行う必要があるものは丁寧にやり方を教えて。」

導入が完了したら、
「デバッグモード用ショートカットとantigravity-discord-botの起動用ショートカットをデスクトップに作成して」
も必要に応じてプロンプトを送信しても良いかもしれません。

導入方法でわからないことやエラーがあれば都度antigravityのAIチャットで質問すればどうにか導入できるはずです。

> [!TIP]
> **許可ボタンの自動クリック機能について**
> v1.2より、AIエージェントが実行する「Run」や「Allow Once」といった承認ボタンを自動でクリックする **「自動承認モード (Auto-approval mode)」** が搭載されました。以下のDiscordコマンドで制御可能です。
>
> v1.3では、Discord上のボタンがAntigravity側のボタン名（Run, Allow Onceなど）をそのまま反映するようになりました。また、`rm -rf /` 等の危険なコマンドは自動承認モードでもブロックされ、手動承認が求められます。

## 開発状況

現在進行形で改良を続けており、3/3現在も不具合の改善や機能の追加を随時行っています。
ご不便おかけします。
私自身はリモートデスクトップと、拡張機能Agent Auto Approveと併用して使用しています。

開発の最新状況やアップデートについては、以下のX（旧Twitter）アカウントにて発信しています。
[https://x.com/harunamix](https://x.com/harunamix)

## 🚀 主な機能

1.  **テキスト生成**: DiscordメッセージをそのままAntigravityに転送し、生成を開始します。
2.  **ファイル添付**: 画像やテキストファイルを添付してAntigravityに送信できます。
3.  **モデル切替**: `/model` コマンドでAIモデルを切り替えられます。
4.  **モード切替**: `/mode` コマンドでPlanning/Fastモードを切り替えられます。
5.  **自動承認**: `/auto` コマンドで承認ボタンの自動クリックをON/OFFできます。
6.  **動的ボタンラベル**: Discord上の承認ボタンがAntigravity側のラベル（Run, Allow Once等）を反映します。
7.  **Smart Safety**: 自動承認モードでも破壊的コマンド（`rm -rf /` 等）を検出し、手動承認を要求します。
8.  **スクリーンショット**: `/screenshot` コマンドで現在の画面を取得できます。
9.  **生成停止**: `/stop` コマンドで生成を中断できます。
10. **新規チャット**: `/newchat` コマンドで新しい会話を開始できます。
11. **最終レスポンス取得**: `/last_response` コマンドで直前のAI回答を再取得できます。
12. **ファイル監視**: プロジェクトディレクトリ内のファイル変更を検知し、Discordに通知します。

## 🛠️ 事前準備 (Discord Botの作成)

### 1. Discord Botの作成とトークン取得
1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセスし、ログインします。
2. 右上の **"New Application"** をクリックし、名前（例: `AntigravityBot`）を入力して作成します。
3. 左メニューの **"Bot"** を選択し、**"Reset Token"** をクリックしてトークンを生成・コピーします。
   - ※このトークンが `.env` の `DISCORD_BOT_TOKEN` になります。
4. 同ページ（Botタブ）の下部にある **"Privileged Gateway Intents"** セクションで、以下を **ON** にします。
   - **PRESENCE INTENT**
   - **SERVER MEMBERS INTENT**
   - **MESSAGE CONTENT INTENT** (重要: これがないとメッセージを読み取れません)
5. 設定を変更したら必ず **Warning: Save Changes** ボタンで保存してください。

### 2. Botをサーバーに招待
1. 左メニューの **"OAuth2"** -> **"URL Generator"** を選択します。
2. **SCOPES** で `bot` にチェックを入れます。
3. **BOT PERMISSIONS** で以下にチェックを入れます（最低限必要な権限）。
   - Read Messages/View Channels
   - Send Messages
   - Send Messages in Threads
   - Embed Links
   - Attach Files
   - Read Message History
4. 生成されたURLをコピーし、ブラウザで開いてBotを自分のサーバーに追加します。

### 3. DiscordユーザーIDの取得
1. Discordアプリの **「ユーザー設定」** (歯車アイコン) -> **「詳細設定」** を開きます。
2. **「開発者モード」** をオンにします。
3. 自分のユーザーアイコンまたは名前を右クリックし、**「ユーザーIDをコピー」** を選択します。
   - ※このIDが `.env` の `DISCORD_ALLOWED_USER_ID` になります。

## 📦 導入方法

### 必要要件
- Node.js (v18以上推奨)
- Antigravity (デバッグポート 9222 で起動していること)

### インストール手順

1. リポジトリをクローンします。
   ```bash
   git clone https://github.com/harunamitrader/antigravity-discord-bot.git
   cd antigravity-discord-bot
   ```

2. 依存パッケージをインストールします。
   ```bash
   npm install
   ```

3. 環境変数を設定します。
   リポジトリに含まれる `.env.example` をコピーして `.env` という名前で保存し、中身を書き換えてください。
   
   **Windows (PowerShell):**
   ```powershell
   cp .env.example .env
   ```
   **Mac/Linux:**
   ```bash
   cp .env.example .env
   ```

   その後、`.env` ファイルを開き、トークンなどを入力します。

### 起動方法

1. **Antigravityをデバッグモードで起動**
   - Antigravityのショートカットをコピーして作成します。
   - ショートカットを右クリックし、**「プロパティ」** を開きます。
   - **「リンク先」** の末尾に半角スペースを入れて `--remote-debugging-port=9222` を追加します。
     - 例: `"C:\...\Antigravity.exe" --remote-debugging-port=9222`
   - 「OK」を押して保存し、そのショートカットからアプリを起動します。

2. **ボットを起動**
   ```bash
   node discord_bot.js
   ```

## 📖 コマンド一覧

| コマンド | 説明 |
|---|---|
| `/help` | コマンド一覧と使い方の表示 |
| `/status` | モデル、モード、自動承認の状態を表示 |
| `/auto` | 現在の自動承認設定を確認 |
| `/auto target:on/off` | 自動承認をON/OFFに切り替え |
| `/model` | 利用可能なモデル一覧を表示 |
| `/model number:<番号>` | 指定したモデルに切り替える |
| `/mode` | 現在のモードを表示 |
| `/mode target:<planning/fast>` | モードを切り替える |
| `/title` | チャットタイトルを表示 |
| `/newchat` | 新しいチャットを開始 |
| `/stop` | 生成を停止 |
| `/screenshot` | スクリーンショットを取得 |
| `/last_response` | 直前のAI回答を再取得 |

## 🛠️ 技術仕様

詳細な仕様については [SPECIFICATION.md](SPECIFICATION.md) を参照してください。

## 📝 変更履歴

詳細な変更履歴については [CHANGELOG.md](CHANGELOG.md) を参照してください。

## 📜 ライセンス

MIT License
