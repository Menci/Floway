const jaJP = {
  "translation": {
    "app": {
      "title": "Floway",
      "documentTitle": "{{title}} | Floway"
    },
    "common": {
      "language": "言語",
      "english": "English",
      "simplifiedChinese": "簡体字中国語",
      "traditionalChineseHongKong": "繁體中文（香港）",
      "traditionalChineseTaiwan": "繁體中文（台灣）",
      "loading": "読み込み中...",
      "cancel": "キャンセル",
      "japanese": "日本語"
    },
    "auth": {
      "adminKeyHint": "ユーザー名を空欄にすると既定の管理者としてサインインできます。ローカル開発で <adminKey>ADMIN_KEY</adminKey> が未設定の場合はパスワードも空欄にし、それ以外では ADMIN_KEY を入力してください。",
      "login": {
        "title": "サインイン",
        "subtitle": "Floway にサインインします。",
        "username": "ユーザー名",
        "usernamePlaceholder": "ユーザー名",
        "password": "パスワード",
        "passwordPlaceholder": "パスワードを入力してください",
        "submit": "サインイン",
        "submitting": "サインイン中...",
        "genericError": "サインインできません。ゲートウェイを確認してから、もう一度お試しください。"
      }
    },
    "provider": {
      "custom": "カスタム",
      "azure": "Azure",
      "copilot": "Copilot",
      "codex": "Codex",
      "claude-code": "Claude Code",
      "ollama": "Ollama",
      "unknown": "不明"
    },
    "dashboard": {
      "title": "ダッシュボード",
      "groups": {
        "console": "コンソール",
        "providers": "プロバイダー",
        "services": "サービス",
        "monitor": "モニタリング",
        "admin": "管理"
      },
      "nav": {
        "label": "ダッシュボードのナビゲーション",
        "playground": "チャット",
        "upstreams": "アップストリーム",
        "search": "検索",
        "proxy": "プロキシ",
        "modelAliases": "モデルエイリアス",
        "apiKeys": "API キー",
        "apiDocs": "API ドキュメント",
        "requests": "リクエスト履歴",
        "usage": "使用量",
        "performance": "パフォーマンス",
        "users": "ユーザー",
        "backupRestore": "バックアップ/復元",
        "settings": "設定"
      },
      "logout": {
        "label": "サインアウト",
        "title": "Floway からサインアウトしますか？",
        "message": "サインアウトすると、Floway コンソールにアクセスするには再度サインインが必要になります。",
        "action": "サインアウト"
      },
      "pages": {
        "playground": "コンソールでモデルと対話し、リクエストの動作を確認します。",
        "upstreams": "モデルプロバイダーのルーティング優先度、稼働状態、モデルカタログ、接続設定を管理します。",
        "proxy": "プロキシルート、転送方式、ゲートウェイ単位のプロキシ設定を管理します。",
        "apiKeys": "クライアントが Floway を呼び出す際に使用する API キーを作成、管理します。",
        "apiDocs": "Floway ゲートウェイの API リファレンスと接続手順を確認します。",
        "requests": "リクエスト履歴、ステータス、ルーティング結果、エラーの詳細を確認します。",
        "usage": "ユーザー、キー、モデル、アップストリーム別に Token 使用量とトラフィックを確認します。",
        "performance": "レイテンシ、スループット、アップストリームのパフォーマンス指標を確認します。",
        "users": "コンソールユーザー、権限、可観測性へのアクセス、利用可能なアップストリームを管理します。",
        "backupRestore": "ゲートウェイ設定とコントロールプレーンデータをエクスポートまたは復元します。",
        "readonly": "一般ユーザーとしてサインインしています。この領域は読み取り専用です。",
        "adminOnly": "管理者権限が必要です。",
        "adminOnlyDescription": "このページは管理者のみ利用でき、一般ユーザーのサイドバーには表示されません。"
      },
      "playground": {
        "system": "カスタムシステムプロンプト",
        "systemPlaceholder": "任意のモデル指示",
        "key": "API キー",
        "api": "プロトコル",
        "model": "モデル",
        "modelPlaceholder": "モデルを検索する",
        "messagePlaceholder": "メッセージを入力",
        "imagePlaceholder": "https://example.com/image.png",
        "empty": "メッセージを送信して会話を始めましょう。",
        "emptyResponse": "（空の応答）",
        "generating": "生成中",
        "noKey": "チャットを使用する前に API キーを作成してください。",
        "noKeyOption": "API キーなし",
        "noModel": "モデルが選択されていません",
        "noModelForApi": "このプロトコルをサポートする到達可能なチャット モデルはありません。",
        "apis": {
          "responses": "Responses",
          "chatCompletions": "Chat Completions",
          "messages": "Messages"
        },
        "settings": {
          "connection": "接続",
          "generation": "生成パラメーター",
          "customJson": "カスタム JSON"
        },
        "actions": {
          "newTopic": "新しいトピック",
          "edit": "編集",
          "delete": "削除",
          "save": "保存",
          "image": "画像 URL を追加",
          "send": "送信",
          "stop": "停止"
        },
        "parameters": {
          "temperature": "温度",
          "maxOutputTokens": "最大出力トークン",
          "topP": "Top P",
          "frequencyPenalty": "頻度ペナルティ",
          "presencePenalty": "存在ペナルティ",
          "stopSequences": "停止シーケンス",
          "reasoningEffort": "推論レベル",
          "providerDefault": "プロバイダーのデフォルト値",
          "unset": "未設定"
        },
        "customJsonHint": "プロトコル固有のフィールドは、上のコントロールで指定した値より優先されます。",
        "errors": {
          "imageUnsupported": "現在のモデルは画像入力に対応していません。",
          "imageUrl": "有効な絶対画像 URL を入力してください。",
          "customInvalid": "カスタム JSON の形式が正しくありません。",
          "customObject": "カスタム JSON はオブジェクトである必要があります。",
          "customReserved": "予約済みフィールドを削除してください：{{fields}}。"
        }
      },
      "settings": {
        "eyebrow": "アカウント",
        "description": "Floway アカウントのセキュリティを管理します。",
        "changePassword": "パスワードを変更する",
        "currentPassword": "現在のパスワード",
        "newPassword": "新しいパスワード",
        "confirmPassword": "パスワードの確認",
        "otherDevices": "現在ログインしている他のデバイスはサインアウトされます。",
        "save": "保存",
        "saving": "保存中...",
        "passwordUpdated": "パスワードを更新しました。他のデバイスからサインアウトしました。",
        "validation": {
          "currentPasswordRequired": "現在のパスワードが必要です。",
          "newPasswordRequired": "新しいパスワードが必要です。",
          "passwordMismatch": "パスワードが一致しません。"
        }
      },
      "apiDocs": {
        "endpointsTitle": "API エンドポイント",
        "docsLink": "ドキュメント"
      },
      "users": {
        "loading": "ユーザーを更新しています",
        "empty": "ユーザーはいません。",
        "actions": {
          "create": "新規ユーザー",
          "edit": "ユーザーを編集",
          "resetPassword": "パスワードをリセット",
          "delete": "ユーザーを削除",
          "refresh": "ユーザーを更新",
          "retry": "再試行",
          "save": "変更を保存",
          "saving": "保存中...",
          "deleting": "削除中..."
        },
        "table": {
          "label": "Floway ユーザー",
          "username": "ユーザー名",
          "role": "ロール",
          "telemetry": "全体の可観測性",
          "upstreams": "アップストリーム権限",
          "created": "作成日時",
          "actions": "操作"
        },
        "role": {
          "admin": "管理者",
          "operator": "オペレーター"
        },
        "state": {
          "enabled": "有効",
          "scoped": "自分のデータのみ"
        },
        "upstreams": {
          "all": "すべてのアップストリーム",
          "count_one": "{{count}} 件のアップストリーム",
          "count_other": "{{count}} 件のアップストリーム",
          "override": "利用可能なアップストリームを制限",
          "description": "オフの場合、このユーザーはすべてのアップストリームを利用できます。API キー側の制限も引き続き適用されます。",
          "select": "利用可能なアップストリーム"
        },
        "dialog": {
          "createTitle": "新規ユーザー",
          "editTitle": "{{username}} を編集",
          "passwordTitle": "{{username}} のパスワードをリセット"
        },
        "form": {
          "username": "ユーザー名",
          "usernameHint": "英数字、ピリオド、ハイフン、アンダースコアを使用できます。最大 64 文字です。",
          "password": "初期パスワード",
          "newPassword": "新しいパスワード",
          "confirmPassword": "新しいパスワード（確認）",
          "administrator": "管理者",
          "administratorDescription": "ユーザー、アップストリーム、検索設定、データ移行を管理できます。",
          "userOneLocked": "初期管理者は降格できません。",
          "selfLocked": "自分のアカウントを降格することはできません。",
          "telemetry": "全体の可観測性へのアクセス",
          "telemetryDescription": "他のユーザーの使用量とパフォーマンスデータを表示できます。",
          "telemetryAdmin": "管理者は常に全体の可観測性にアクセスできます。"
        },
        "validation": {
          "username": "ユーザー名には 1～64 文字の英数字、アンダースコア、ピリオド、ハイフンを使用してください。",
          "passwordRequired": "パスワードを入力してください。",
          "passwordMax": "パスワードは 1024 文字以下である必要があります。",
          "passwordMismatch": "入力したパスワードが一致しません。",
          "upstreamRequired": "アップストリームを 1 件以上選択するか、制限をオフにしてください。"
        },
        "delete": {
          "title": "ユーザーの削除",
          "message": "{{username}} を削除しますか？このユーザーのセッションは無効になり、API キーも使用できなくなります。この操作は元に戻せません。"
        },
        "createdDefaultKey": "新しいユーザーには Default API キーが自動的に作成されます。"
      },
      "apiKeys": {
        "loading": "API キーを更新しています",
        "empty": "API キーはまだありません。作成すると Floway を呼び出せます。",
        "actions": {
          "create": "API キーを作成",
          "save": "変更を保存",
          "saving": "保存中...",
          "copy": "コピー",
          "edit": "API キーを編集",
          "rotate": "API キーをローテーション",
          "delete": "API キーを削除"
        },
        "copy": {
          "copied": "コピーしました",
          "failed": "コピーに失敗しました"
        },
        "toast": {
          "create": {
            "pending": "API キー {{name}} を作成しています",
            "success": "API キー {{name}} を作成しました",
            "error": "API キー {{name}} を作成できませんでした：{{message}}"
          },
          "edit": {
            "pending": "API キー {{name}} を保存しています",
            "success": "API キー {{name}} を保存しました",
            "error": "API キー {{name}} を保存できませんでした：{{message}}"
          },
          "rotate": {
            "pending": "API キー {{name}} をローテーションしています",
            "success": "API キー {{name}} をローテーションしました",
            "error": "API キー {{name}} をローテーションできませんでした：{{message}}"
          },
          "delete": {
            "pending": "API キー {{name}} を削除しています",
            "success": "API キー {{name}} を削除しました",
            "error": "API キー {{name}} を削除できませんでした：{{message}}"
          }
        },
        "table": {
          "title": "API キー",
          "name": "名前",
          "key": "Key",
          "upstreams": "アップストリーム",
          "created": "作成日時",
          "lastUsed": "最終使用日時",
          "actions": "操作",
          "never": "未使用",
          "usedOn": "{{date}} に使用"
        },
        "source": {
          "generate": "ランダム生成",
          "custom": "カスタム"
        },
        "dialog": {
          "createTitle": "API キーを作成",
          "editTitle": "API キーを編集"
        },
        "form": {
          "name": "名前",
          "customKey": "カスタム API キー",
          "customKeyPlaceholder": "カスタム API キーを貼り付け",
          "retention": "リクエストダンプを記録",
          "retentionHint": "有効にすると、このキーを使用したモデルリクエストが設定した期間だけ記録されます。",
          "retentionCustom": "カスタム保持期間",
          "retentionPlaceholder": "例：30m、2h、3d、1800"
        },
        "validation": {
          "nameRequired": "名前は必須です。",
          "upstreamRequired": "少なくとも 1 つのアップストリームを選択するか、オーバーライドをオフにします。",
          "customKeyRequired": "カスタム API キーが必要です。",
          "retentionInvalid": "保持期間は秒数、または 30m、2h、3d のような値で指定してください。"
        },
        "upstreams": {
          "title": "利用可能なアップストリームを上書き（{{count}}）",
          "inheritDescription": "オフの場合、このキーはアカウントで利用可能なすべてのアップストリームを継承します。",
          "enabled": "有効",
          "order": "順序",
          "name": "名前",
          "kind": "種類",
          "moveUp": "上に移動",
          "moveDown": "下に移動",
          "all": "すべて",
          "none": "なし",
          "summary": "{{first}} +{{count}}",
          "inheritsTitle": "全体のアップストリーム順序を継承"
        },
        "retention": {
          "off": "オフ",
          "1h": "1時間",
          "6h": "6時間",
          "24h": "24時間",
          "7d": "7日間",
          "custom": "カスタム",
          "warningDisable": "保存すると、このキーに対してキャプチャされたリクエストがすぐに削除されます。",
          "warningShrink": "保存すると、新しい保持期間を超えた記録済みリクエストはすぐに削除されます。"
        },
        "configuration": {
          "title": "コーディングエージェントへの接続",
          "selected": "以下のスニペットでは <strong>{{name}}</strong> キーを使用します。",
          "claudeCode": "Claude Code",
          "codex": "Codex",
          "model": "モデル",
          "fable": "Fable",
          "opus": "Opus",
          "sonnet": "Sonnet",
          "haiku": "Haiku",
          "onlyClaudeModels": "Claude モデルのみ表示",
          "onlyGpt5Models": "GPT-5 シリーズのモデルのみ表示",
          "claudeHint": "env ブロックを ~/.claude/settings.json または .claude/settings.json にマージします。",
          "codexConfigHint": "~/.codex/config.toml にマージします。",
          "codexAuthHint": "Linux / macOS：CODEX_HOME 配下に Floway プロバイダートークンのみを保存します。",
          "codexWindowsAuthHint": "Windows PowerShell：公式アカウントのログインを変更せず同じトークンを保存します。"
        },
        "agentSetup": { "accessMethod": "接続方法", "setupTab": "自動設定スクリプト", "snippetsTab": "設定ファイルのスニペット", "platform": "OS", "modelSelection": "モデル選択", "miscSettings": "その他の設定", "saving": "保存中…", "selectKey": "上で API キーを選択してください。", "preparing": "セットアップを準備中…", "noKey": "API キーを作成してください。", "expired": "セットアップリンクの有効期限が切れました。再試行してください。", "retry": "再試行", "commandPending": "# セットアップコマンドを準備中…", "expires": "ページが表示されている間は自動更新され、離れると数分後に失効します。", "defaultModel": "既定のモデル", "opusModel": "Opus モデル", "sonnetModel": "Sonnet モデル", "haikuModel": "Haiku モデル", "reasoningEffort": "推論強度", "modelDefault": "既定", "noModelMatches": "一致するモデルがありません", "modelDiscovery": "Gateway モデル検出", "modelDiscoveryHint": "Claude Code がこの Floway gateway から利用可能なモデルを検出できるようにします。", "cleanupRetention": "クリーンアップ保持期間", "cleanupRetentionHint": "Claude Code がローカルセッションデータを保持する期間を設定します。", "cleanupDays": "{{count}} 日", "optOutAiAttribution": "Claude Code の AI 帰属表示を無効化", "optOutAiAttributionHint": "コミットと Pull Request から Claude Code の帰属情報（\"Co-Authored-By\"）を削除し、セッションリンクを非表示にします。", "unavailable": "{{id}}（利用不可）" },
        "rotate": {
          "title": "API キーをローテーション",
          "message": "{{name}} の新しいキーを選択してください。ローテーション後、古いキーはすぐに使用できなくなります。"
        },
        "delete": {
          "title": "API キーを削除",
          "message": "キー {{name}} を削除しますか？この操作は元に戻せず、キーはすぐに使用できなくなります。"
        }
      },
      "upstreams": {
        "empty": "アップストリームはまだ設定されていません。追加するとモデルを提供できます。",
        "actions": {
          "create": "新しいアップストリーム",
          "refresh": "アップストリームを更新",
          "retry": "再試行",
          "edit": "アップストリームを編集",
          "delete": "アップストリームの削除",
          "editNamed": "{{name}} を編集",
          "deleteNamed": "{{name}} を削除",
          "deleting": "削除中...",
          "toggle": "{{name}} の有効状態を切り替え",
          "moveUp": "{{name}} を上に移動",
          "moveDown": "{{name}} を下に移動",
          "more": "{{name}} のその他のアクション"
        },
        "table": {
          "title": "ルーティングの優先順位",
          "priority": "優先度",
          "upstream": "アップストリーム",
          "provider": "プロバイダー",
          "models": "モデル",
          "enabled": "有効",
          "actions": "操作"
        },
        "providers": {
          "custom": "OpenAI または Anthropic 互換エンドポイント",
          "azure": "Azure OpenAI または Foundry",
          "copilot": "GitHub Copilot アカウント",
          "codex": "ChatGPT Plus、Pro、または Team",
          "claude-code": "Claude Pro、Max、または Team のサブスクリプション",
          "ollama": "ollama.com またはセルフホストサービス"
        },
        "models": {
          "count_one": "{{count}} 件のモデル",
          "count_other": "{{count}} 件のモデル",
          "unavailable": "件数を取得できません"
        },
        "cache": {
          "ready": "キャッシュの準備完了",
          "empty": "ロードされていません",
          "failed": "更新に失敗しました",
          "readyDetail": "モデルキャッシュの最終更新：{{time}}。",
          "emptyDetail": "このアップストリームのモデルキャッシュはまだ生成されていません。",
          "failedDetail": "直近の更新は {{time}} に失敗しました：{{message}}"
        },
        "summary": {
          "ollama": "Ollama エンドポイント",
          "copilot": "GitHub Copilot アカウント",
          "noAccount": "アカウントが接続されていません"
        },
        "busy": {
          "reload": "アップストリームを更新しています",
          "toggle": "稼働状態を更新しています",
          "reorder": "ルーティング優先度を更新しています",
          "delete": "アップストリームを削除しています"
        },
        "errors": {
          "models": "モデル数を取得できません：{{message}}",
          "toggle": "稼働状態を更新できませんでした：{{message}}",
          "reorder": "ルーティング優先度を更新できませんでした：{{message}} {{sync}}",
          "delete": "アップストリームを削除できませんでした：{{message}}",
          "syncFailed": "サーバー側の順序を再取得できませんでした。"
        },
        "delete": {
          "title": "アップストリームの削除",
          "message": "アップストリーム {{name}} を削除しますか？この操作は元に戻せません。"
        },
        "toast": {
          "missing": "このアップストリームは削除されました。",
          "deleted": "アップストリーム {{name}} が削除されました。"
        }
      },
      "upstreamEditor": {
        "new": "新しいアップストリーム",
        "documentTitleNew": "新しいアップストリーム",
        "documentTitleEdit": "アップストリームの詳細",
        "optional": "任意",
        "unsaved": "未保存の変更",
        "secretKeep": "変更しない場合は空白のままにします。",
        "pathOverridesHint": "空欄の場合は、対応するデフォルトの /v1 パスを使用します。",
        "disabledModelsHint": "現在表示されているモデルは、モデル一覧で有効・無効を切り替えてください。ここでは、表示されなくなったモデルや接続不能なモデルの ID を追加で指定できます。",
        "prefixInvalid": "プレフィックスは / で終わり、英数字、ピリオド、アンダースコア、ハイフン、スラッシュのみを使用し、{{max}} 文字以内にしてください。",
        "prefixDescription": "受信したモデル ID の文字列プレフィックスとして照合します。末尾は / にしてください。",
        "actions": {
          "back": "アップストリーム一覧に戻る",
          "save": "変更を保存",
          "saving": "保存中...",
          "moveUp": "上に移動",
          "moveDown": "下に移動",
          "remove": "削除",
          "showSecret": "API キーを表示",
          "hideSecret": "API キーを非表示"
        },
        "sections": {
          "connection": "接続と認証",
          "color": "バッジの色",
          "proxy": "プロキシルーティング",
          "apiPaths": "API パス",
          "prefix": "モデル名のプレフィックス",
          "disabledModels": "無効モデル"
        },
        "color": {
          "description": "コンソールでこのアップストリームを識別する色を選択します。",
          "mode": "色",
          "inherit": "プロバイダーの既定値",
          "custom": "カスタム 16 進数",
          "hex": "16 進数カラー",
          "invalid": "#RRGGBB 形式で入力してください。",
          "preset": { "amber": "アンバー", "emerald": "エメラルド", "cyan": "シアン", "violet": "バイオレット", "rose": "ローズ", "orange": "オレンジ" }
        },
        "fields": {
          "name": "アップストリーム名",
          "enabled": "有効",
          "baseUrl": "Base URL",
          "endpoint": "エンドポイント",
          "authStyle": "認証方式",
          "apiKey": "API キー",
          "fetchModels": "アップストリームからモデル一覧を取得",
          "modelsPath": "モデル一覧のパス",
          "defaultEndpoints": "デフォルト LLM API",
          "pathOverrides": "パスのオーバーライド",
          "modelIds": "モデル ID"
        },
        "auth": {
          "none": "なし"
        },
        "proxy": {
          "direct": "直接接続",
          "directFetch": "直接接続（Fetch）",
          "directConnect": "直接接続（TCP connect）",
          "empty": "フォールバック出口は未設定です。既定では直接 Fetch を使用します。",
          "add": "フォールバック出口を追加",
          "colo": "現在の Cloudflare colo：{{colo}}"
        },
        "prefix": {
          "unprefixed": "プレフィックスなし",
          "prefixed": "プレフィックスあり",
          "addressable": "ルーティング可能",
          "listed": "モデル一覧に表示"
        },
        "tabs": {
          "models": "モデル一覧",
          "flags": "アップストリーム機能フラグ"
        },
        "flags": {
          "intro": "アップストリームの動作は、プロバイダー、API、モデルによって異なります。互換性の確保に必要な場合のみ、これらのデフォルト設定を変更してください。",
          "inherit": "デフォルト",
          "on": "オン",
          "off": "オフ",
          "inheritResolved": "デフォルト（{{state}}）",
          "groups": {
            "vendor": "アップストリームプロバイダー互換",
            "shims": "機能互換レイヤー",
            "apiCompatibility": "API 機能の互換性",
            "sanitization": "リクエストの正規化",
            "retry": "再試行ポリシー",
            "other": "その他"
          },
          "entries": {
            "vendor-deepseek": {
              "label": "DeepSeek 互換",
              "description": "DeepSeek の「OpenAI 互換 API」は、推論フィールドと構造化出力に非標準形式を使用します。\nこのオプションを有効にすると、OpenAI の正規形式と DeepSeek の非標準形式の間でリクエストと応答を双方向に変換できます。これには、推論制御 (`thinking`) と推論コンテンツ (`reasoning_text`) の変換、キャッシュされたトークンの使用の正規化、サポートされていない `json_schema` 応答形式の `json_object` へのダウングレードが含まれます。\nアップストリームが **DeepSeek Chat Completions API** の場合、これを有効にします。"
            },
            "vendor-qwen": {
              "label": "Alibaba Cloud Model Studio 互換",
              "description": "Alibaba Cloud Model Studio の「OpenAI 互換 Chat API」は、推論を無効にするための非標準メカニズムを使用しています。\nこのオプションを有効にすると、OpenAI の正規の「推論の無効化」リクエスト (`reasoning_effort: \"none\"`) が Qwen の最上位フィールド (`enable_thinking: false`) に変換されます。\nアップストリームが **Alibaba Cloud Model Studio (Qwen) Chat Completions API** の場合、これを有効にします。"
            },
            "vendor-kimi": {
              "label": "Kimi 互換",
              "description": "Kimi の API は、キャッシュされたトークンの使用統計に非標準形式を使用します。\nこのオプションを有効にすると、Kimi 応答のフラット キャッシュ トークン フィールド (`cached_tokens`) が OpenAI 正規形式 (`prompt_tokens_details.cached_tokens`) に正規化されます。\nアップストリームが **Kimi (Moonshot AI) Chat Completions API** の場合、これを有効にします。"
            },
            "retry-cyber-policy": {
              "label": "セキュリティポリシーによるブロックを再試行",
              "description": "OpenAI の Cybersecurity セキュリティポリシーにより、一部のリクエストが `cyber_policy` の誤検知でブロックされる場合があります。\n有効にすると、アップストリームの誤検知によって `cyber_policy` の 4xx エラーが返された場合に、自動で最大 10 回再試行します。"
            },
            "messages-web-search-shim": {
              "label": "Messages ウェブ検索互換レイヤー",
              "description": "Anthropic Messages API にはウェブ検索機能がありますが、このアップストリームは検索に対応していない場合があります。\n有効にすると、ウェブ検索ツールの呼び出しをアップストリームへ転送せず、Floway に設定した検索プロバイダーで処理します。\nアップストリームが Messages API を提供していない場合、この設定は有効として扱われます。"
            },
            "responses-web-search-shim": {
              "label": "Responses ウェブ検索互換レイヤー",
              "description": "Responses API にはウェブ検索機能がありますが、このアップストリームは検索に対応していない場合があります。\n有効にすると、ウェブ検索（`web_search`）ツールの呼び出しをアップストリームへ転送せず、Floway に設定した検索プロバイダーで処理します。\nアップストリームが Responses API を提供していない場合、この設定は有効として扱われます。"
            },
            "responses-image-generation-shim": {
              "label": "Responses 画像生成互換レイヤー",
              "description": "Responses API には画像生成機能がありますが、このアップストリームは画像生成に対応していない場合があります。\n有効にすると、画像生成ツール（`image_generation`）をこのアップストリームへ転送せず、Floway 内の画像生成対応モデル（`gpt-image-*` を含む）がある別のアップストリームへ転送します。\nアップストリームが Responses API を提供していない場合、この設定は有効として扱われます。"
            },
            "responses-compact-shim": {
              "label": "Responses コンテキスト圧縮互換レイヤー",
              "description": "Responses API にはコンテキスト圧縮機能がありますが、このアップストリームはネイティブのコンテキスト圧縮に対応していない場合があります。\n有効にすると、Floway は圧縮リクエストを通常の生成リクエストに書き換え、Codex のコンテキスト引き継ぎ用要約プロンプトを挿入してネイティブ圧縮を再現します。後続のリクエストでも、圧縮前のタスクコンテキストが引き継がれます。\nアップストリームが Responses API を提供していない場合、この設定は有効として扱われます。"
            },
            "disable-reasoning-on-forced-tool-choice": {
              "label": "ツール呼び出しの強制時に推論を無効化",
              "description": "一部のアップストリームは「ツール呼び出しの強制」と推論モードの同時使用に対応しておらず、このようなリクエストを拒否します。\n有効にすると、呼び出し元が `tool_choice` で特定のツールを強制した場合、Floway は転送時に**推論モードを無効にします**。"
            },
            "demote-interleaved-system-to-user": {
              "label": "途中の system ロールを書き換え",
              "description": "一部のアップストリームは会話の先頭でのみ `system` ロールを許可し、`user` や `assistant` メッセージの間にある `system` メッセージ（DeepSeek-R1 など）を受け付けません。\n有効にすると、会話先頭の連続した `system` メッセージは維持し、それ以降の `system` ロールを `user` に書き換えます。メッセージ内容は変更しません。\nMessages API のアップストリームでは、システムプロンプトを最上位の `system` フィールドにしか配置できないため、この設定は有効として扱われます。"
            },
            "demote-developer-to-system": {
              "label": "developer ロールを書き換え",
              "description": "OpenAI の新しい API 仕様には `developer` ロール（`role`）がありますが、一部のアップストリームは対応していません。\n有効にすると、アップストリームへリクエストを送信する際に `developer` を `system` に書き換えます。\nたとえば、Codex のシステムプロンプトは `developer` ロールを使用しますが、DeepSeek は対応していないため、この場合は有効にしてください。"
            },
            "strip-billing-attribution": {
              "label": "Claude Code の請求帰属マーカーを削除",
              "description": "Claude Code は、Anthropic が請求先を判定できるようシステムプロンプトに `x-anthropic-billing-header` を追加します。ただし、**Anthropic 公式以外のアップストリーム**では意味がなく、**プレフィックスキャッシュを破壊する可能性があります**。\nAnthropic 公式以外のアップストリームでは、このマーカーをシステムプロンプトから削除するために有効にしてください。\nClaude Code などの**Anthropic 公式アップストリームでは有効にしないでください**。請求に影響する可能性があります。"
            },
            "strip-prompt-cache-key": {
              "label": "プロンプトキャッシュキーの削除",
              "description": "OpenAI API は、再利用可能なプロンプトのプレフィックスを識別する `prompt_cache_key` に対応していますが、一部のアップストリームはこのフィールドに対応しておらず、リクエストを拒否する場合があります（Azure が提供する DeepSeek モデルなど）。\n有効にすると、アップストリームへ送信する前に最上位の `prompt_cache_key` フィールドを削除します。"
            }
          }
        },
        "models": {
          "title": "モデル",
          "summary": "全 {{total}} 件・手動 {{manual}} 件・自動 {{auto}} 件",
          "auto": "自動",
          "manual": "手動",
          "add": "追加",
          "refresh": "モデルを更新",
          "cacheNever": "未取得",
          "cacheFetched": "{{time}} 前に取得",
          "cacheFailed": "前回の取得に失敗",
          "cacheErrorDetail": "{{time}} — {{message}}",
          "listingFailed": "アップストリームからモデルリストを取得できませんでした。",
          "listingFailedWithDetail": "アップストリームからモデル一覧を取得できませんでした：{{message}}",
          "search": "モデル名または ID を検索",
          "enabled": "有効",
          "name": "モデル名",
          "id": "モデルコード",
          "source": "設定方法",
          "kind": "種類",
          "actions": "操作",
          "copy": "モデル ID をコピー",
          "edit": "モデルを編集",
          "back": "モデル一覧に戻る",
          "identity": "識別情報",
          "displayName": "表示名",
          "displayNamePlaceholder": "例：GPT 5.4 Pro",
          "deployment": "Deployment",
          "deploymentPlaceholder": "Azure デプロイメント名",
          "upstreamId": "アップストリームモデル ID",
          "upstreamIdPlaceholder": "元のアップストリームモデル ID",
          "publicId": "公開モデル ID",
          "publicIdPlaceholder": "公開モデル ID",
          "endpoints": "対応 API",
          "capabilities": "機能と制限",
          "contextWindow": "コンテキストウィンドウ",
          "promptTokens": "プロンプトトークン",
          "outputTokens": "出力トークン",
          "imageInput": "画像入力",
          "reasoning": "推論",
          "effortLevels": "推論レベル",
          "customEffortPlaceholder": "カスタム...",
          "budgetTokens": "推論 Token 予算",
          "adaptive": "自動調整",
          "mandatory": "推論を必須にする",
          "minimum": "最小値",
          "maximum": "最大値",
          "pricing": "料金設定",
          "pricingHint": "Floway の使用量集計とコスト見積もりにのみ使用し、使用量ページに表示します。アップストリームの請求やリクエストパラメーターには影響しません。料金の単位は 100 万 Token あたりの米ドルです。",
          "pricingRules": "料金ルール",
          "pricingEmptyHint": "まず基本料金を設定します。その後、サービス階層や Token 数に応じた条件料金を追加できます。",
          "setupPricing": "基本料金を設定",
          "addPricingOverride": "条件料金を追加",
          "untitledPricingOverride": "未完成の条件料金",
          "basePricingSummary": "すべてのリクエストの既定料金",
          "overridePricingSummary": "条件に一致した場合のみ使用",
          "basePricingDescription": "どの条件料金にも一致しない場合に使用する既定料金です。",
          "overridePricingDescription": "以下のすべての条件に一致した場合のみ基本料金を上書きします。",
          "pricingConditions": "適用条件",
          "pricingConditionsHint": "両方を空欄にすると基本料金になります。条件料金には少なくとも 1 つの条件が必要です。",
          "serviceTierName": "Service Tier 名",
          "serviceTierPlaceholder": "例：priority",
          "pricingRates": "料金",
          "pricingRatesHint": "100 万 Token あたりの米ドルです。各ルールに 1 つ以上入力し、料金タイプを統一してください。",
          "priceNotSet": "未設定",
          "pricingBase": "基本料金", "serviceTier": "サービス階層", "serviceTierHint": "空欄は基本料金です。", "operator": "演算子", "inputTokens": "入力 Token しきい値", "inputTokensHint": "空欄はすべての入力サイズに適用します。", "addPricingEntry": "料金項目を追加", "removePricingEntry": "料金項目を削除", "noPricingEntries": "料金は未設定です。", "addPricingEntryHint": "基本料金項目を追加してください。", "pricingErrors": "料金検証エラー", "invalidPricing": "料金項目に検証エラーがあります。",
          "pricingIssue": {
            "emptyCatalog": "基本料金を追加してください。",
            "emptyRates": "このルールに 1 つ以上の料金を入力してください。",
            "invalidRate": "{{dimension}} は 0 以上でなければなりません。",
            "invalidSelector": "このルールの適用条件を完成させるか、削除してください。",
            "baseCount": "基本料金は 1 つだけにし、各条件料金に適用条件を追加してください。",
            "rateDimensions": "すべてのルールで基本料金と同じ料金タイプを使用してください。",
            "duplicateSelector": "同じ適用条件を使用しているルールがあります。",
            "thresholdConflict": "同じ Token しきい値で > と ≥ を混在させることはできません。"
          },
          "pricingDimensions": { "input": "入力（$/MTok）", "input_cache_read": "キャッシュ読取", "input_cache_write": "キャッシュ書込", "input_cache_write_1h": "キャッシュ書込 1h", "input_image": "画像入力", "output": "出力", "output_image": "画像出力" },
          "tierPricing": "Service Tier 別の料金上書き（{{count}}）",
          "addTier": "Tier を追加",
          "tierName": "Service Tier 名（例：fast）",
          "inheritPricePlaceholder": "継承",
          "tierIncomplete": "Tier 名と 1 つ以上の料金を入力してください。不完全な Tier は保存されません。",
          "flags": "モデル機能フラグ",
          "flagsHint": "モデルのオーバーライドでは、デフォルトで有効なアップストリーム設定が使用されます。",
          "enableFlagOverrides": "このモデルのフラグを上書きする",
          "invalidEffort": "対応する推論レベルを 1 つ以上指定し、デフォルト値をその中から選択してください。",
          "invalidBudget": "推論 Token 予算の最大値は最小値以上にしてください。",
          "delete": "手動モデルの削除"
        },
        "copilot": {
          "description": "GitHub デバイス認証を使用して GitHub Copilot サブスクリプションを接続します。",
          "connect": "GitHub に接続",
          "deviceCode": "デバイスコード",
          "waiting": "承認を待っています..."
        },
        "oauth": {
          "reimport": "認証情報を再インポート",
          "import": "認証情報をインポート",
          "credentialJson": "認証情報 JSON",
          "preparing": "認証を準備しています...",
          "openAuthorize": "認証ページを開く",
          "copy": "認証 URL をコピー",
          "callback": "リダイレクトされたコールバック URL またはコード",
          "unrecognized": "この認証フローを認識できません。最初からやり直してください。"
        },
        "validation": {
          "name": "アップストリーム名は必須です。",
          "prefix": "ルーティング可能なモデルプレフィックス形式を 1 つ以上残してください。",
          "models": "1 つ以上のモデルで推論設定が無効です。",
          "copilot": "先に GitHub のデバイス認証を完了してください。",
          "credential": "先に認証情報をインポートしてください。"
        },
        "toast": {
          "saved": "アップストリーム設定が保存されました。"
        },
        "leave": {
          "title": "保存されていない変更を破棄しますか？",
          "message": "このアップストリームには保存されていない変更があります。",
          "stay": "編集を続ける",
          "leave": "破棄して移動"
        }
      },
      "requests": {
        "apiKey": "API キー・リクエスト一覧",
        "listLabel": "キャプチャされたリクエスト",
        "empty": "まだリクエストは記録されていません。",
        "unknownModel": "不明なモデル",
        "duration": "所要時間：{{value}}ms",
        "requestBytes": "リクエストペイロード：{{value}} バイト",
        "responseBytes": "レスポンスペイロード：{{value}} バイト",
        "selectPrompt": "右側からリクエストを選択すると、詳細を確認できます。",
        "noKeys": "リクエストの保持が有効になっている API キーはありません。",
        "noKeysDescription": "API キーでリクエストダンプの保持を有効にすると、リクエストの記録を開始できます。",
        "goToApiKeys": "API キーへ移動",
        "request": "リクエスト",
        "requestBody": "リクエスト本文",
        "response": "レスポンス",
        "responseBody": "レスポンス本文",
        "noRequestBody": "リクエスト本文がありません。",
        "noResponseBody": "このリクエストにはレスポンス本文がありません。",
        "noResponseHeaders": "レスポンスヘッダーはありません。",
        "emptyBody": "レスポンス本文は空です。",
        "noStatus": "ステータスコードなし",
        "copy": "コピー",
        "copied": "コピーしました",
        "revealValue": "値を表示",
        "hideValue": "値を非表示にする",
        "decodeError": "この内容をデコードできませんでした（{{error}}）。元の base64 を表示します。",
        "collected": "集約結果",
        "events": "イベント（{{count}}）",
        "noCollector": "このパスに対応するプロトコル集約機能はありません。イベント表示に切り替えて元のフレームを確認してください。",
        "unlabeled": "名前なし",
        "jsonParseFailed": "JSON 解析に失敗しました"
      },
      "usage": {
        "loading": "使用量を読み込んでいます...",
        "refreshing": "使用量を更新しています",
        "tokenUsage": "Token 使用量",
        "empty": "この期間の使用記録はありません。",
        "view": {
          "label": "使用状況ビュー",
          "allByUser": "すべてのユーザー",
          "myKeys": "自分のキー"
        },
        "range": {
          "label": "使用量の期間",
          "today": "直近 1 日",
          "sevenDays": "7日間",
          "thirtyDays": "30日"
        },
        "actions": {
          "refresh": "使用量を更新",
          "redactUsers": "ユーザー名を非表示",
          "redactKeys": "キー名を非表示"
        },
        "series": {
          "all": "すべてのシリーズを表示",
          "invert": "シリーズ選択を反転する",
          "none": "シリーズをすべて非表示にする",
          "toggleHint": "クリックで表示を切り替えます。Shift キーを押しながらクリックするかダブルクリックすると、その系列だけを表示します。"
        },
        "charts": {
          "byUser": "ユーザー別",
          "byKey": "API キー別",
          "byModel": "モデル別",
          "search": "検索使用量",
          "searchWithProvider": "検索使用量・{{provider}}"
        },
        "metrics": {
          "requests": "リクエスト数",
          "cost": "推定コスト",
          "total": "総トークン数",
          "input": "入力トークン",
          "output": "出力トークン",
          "prefill": "Prefill入力",
          "cached": "キャッシュされた入力",
          "cachedRate": "キャッシュ率",
          "cacheCreation": "キャッシュ書き込み",
          "cacheHitRate": "キャッシュヒット率"
        }
      },
      "performance": {
        "loading": "パフォーマンスを読み込んでいます...",
        "refreshing": "パフォーマンスデータを更新しています",
        "empty": "この期間のパフォーマンス記録はありません。",
        "actions": {
          "refresh": "パフォーマンスデータを更新"
        },
        "apiKeyScopeInfo": "API キーのディメンションには、グローバルテレメトリアクセスがある場合でも、常に現在のアカウントが所有する API キーだけが含まれます。その他のディメンションはグローバル範囲のままです。",
        "apiKeyScopeLabel": "API キーテレメトリの範囲について",
        "metric": { "label": "パフォーマンス指標", "ttft": "TTFT", "outputSpeed": "出力速度" },
        "groupBy": { "label": "グループ基準", "model": "モデル別", "upstream": "アップストリーム別", "operation": "操作別", "runtimeLocation": "地域別", "userId": "ユーザー別", "keyId": "API キー別" },
        "filters": { "label": "フィルター", "all": { "model": "すべてのモデル", "upstream": "すべてのアップストリーム", "operation": "すべての操作", "runtimeLocation": "すべての地域", "userId": "すべてのユーザー", "keyId": "すべての API キー" }, "model": "モデル", "upstream": "アップストリーム", "operation": "操作", "runtimeLocation": "地域", "userId": "ユーザー", "keyId": "API キー" },
        "range": {
          "label": "パフォーマンスデータの期間",
          "today": "直近 1 日",
          "sevenDays": "7日間",
          "thirtyDays": "30日"
        },
        "percentile": {
          "label": "パーセンタイル"
        },
        "summary": {
          "requests": "リクエスト数",
          "errors": "エラー",
          "ttftP50": "TTFT p50", "speedP50": "速度 p50",
          "ttftP95": "TTFT p95", "speedP95": "下位 5% の速度",
          "ttftP99": "TTFT p99", "speedP99": "下位 1% の速度"
        },
        "chartTitle": "{{metric}} {{percentile}}・{{group}}",
        "series": {
          "label": "パフォーマンスシリーズの選択",
          "all": "すべてのシリーズを表示",
          "invert": "シリーズ選択を反転する",
          "none": "シリーズをすべて非表示にする",
          "toggleHint": "クリックで表示を切り替えます。Shift キーを押しながらクリックするかダブルクリックすると、その系列だけを表示します。"
        },
        "tables": {
          "requests": "リクエスト数",
          "errors": "エラー",
          "ttftP95": "TTFT p95",
          "speedP95": "下位 5% の速度"
        }
      },
      "backupRestore": {
        "heading": "バックアップ/復元",
        "description": "ゲートウェイ設定とコントロールプレーンデータをエクスポートまたは復元します。",
        "export": {
          "heading": "エクスポート",
          "description": "API キー、サーバーシークレット、アップストリーム、プロキシ、検索設定、使用量データをダウンロードします。データベースのバックアップと同様に安全に保管してください。",
          "includePerformance": "パフォーマンスのテレメトリデータを含める",
          "includePerformanceHint": "有効にすると、設定データに加えて記録済みのパフォーマンス指標もエクスポートします。パフォーマンスデータにより、ファイルサイズが大幅に増える場合があります。",
          "button": "JSON をエクスポート",
          "buttonExporting": "エクスポート中…"
        },
        "import": {
          "heading": "インポート",
          "description": "以前にエクスポートした JSON バックアップファイルから設定を復元します。",
          "dropzone": "バックアップファイルをここにドラッグ＆ドロップするか、クリックして選択",
          "dropzoneActive": "ドロップしてファイルを読み込む",
          "fileSelected": "{{name}}（{{size}}）",
          "change": "変更",
          "preview": "プレビュー",
          "records": "件",
          "mode": "インポートモード",
          "modeMerge": "マージ",
          "modeMergeDesc": "インポートするレコードを既存データに追加します。識別子が一致する既存レコードは上書きされます。",
          "modeReplace": "置換",
          "modeReplaceDesc": "バックアップファイルをインポートする前に、既存データをすべて削除します。",
          "replaceWarning": "置換モードでは、インポート前に既存のデータがすべて完全に削除されます。この操作は元に戻すことができません。",
          "button": "データのインポート",
          "buttonImporting": "インポート中…",
          "success": "インポートは正常に完了しました。",
          "error": "インポートに失敗しました。",
          "errorInvalidFile": "選択したファイルは有効な Floway バックアップ ファイルではありません。",
          "previewLabel": {
            "users": "ユーザー",
            "apiKeys": "API キー",
            "upstreams": "アップストリーム",
            "proxies": "プロキシ",
            "usage": "使用記録",
            "searchUsage": "検索使用量",
            "performance": "パフォーマンス"
          }
        },
        "confirmTitle": "インポートの確認",
        "confirmMessage": "選択したバックアップファイルからデータをインポートします。置換モードでは、既存のデータがすべて削除されます。続行しますか？"
      },
      "searchConfig": {
        "heading": "検索プロバイダー",
        "description": "Anthropic Messages / Responses API のウェブ検索ツール呼び出しに使用するプロバイダーを設定します。",
        "providerLabel": "プロバイダー",
        "provider": {
          "disabled": "無効",
          "tavily": "Tavily",
          "microsoftGrounding": "Microsoft Grounding",
          "jina": "Jina"
        },
        "passthrough": { "title": "OpenAI 検索をパススルー", "description": "/alpha/search と Responses のホスト検索を選択した Codex または OpenAI 互換アップストリームへ転送します。", "upstream": "検索アップストリーム", "model": "検索モデル", "empty": "チャットモデルを持つ有効な Codex または Custom アップストリームを追加してください。" },
        "providerDescTavily": "Tavily は、LLM および RAG ワークフロー用に最適化された検索エンジンです。",
        "providerDescMicrosoftGrounding": "Microsoft Grounding は、LLM 応答をグラウンディングするために Bing Search API を活用します。",
        "providerDescJina": "Jina AI は、Web 検索 API とコンテンツ抽出 API を提供します。",
        "getKeyLink": "API キーを取得 →",
        "apiKeyLabel": "API キー",
        "apiKeyPlaceholder": "API キーを入力してください…",
        "noCredentialNeeded": "無効にすると認証情報は必要ありません。",
        "save": "検索設定の保存",
        "saving": "保存中…",
        "saveSuccess": "検索設定を保存しました。",
        "test": "テスト検索",
        "testing": "テスト中…",
        "testDisabledHint": "プロバイダーを選択するとテストできます。",
        "testResults": "テスト結果",
        "testSuccess": "接続テストに成功しました。{{count}} 件の結果が返されました。",
        "testFailed": "テストに失敗しました：{{message}}",
        "pageAge": "{{age}} 前"
      },
      "modelAliases": {
        "heading": "モデルエイリアス", "description": "仮想モデル ID を作成し、固定リクエストルールを適用しながら 1 つ以上のターゲットモデルへルーティングします。", "listTitle": "エイリアス", "count": "{{count}} 件設定済み", "empty": "エイリアスはまだありません。仮想モデル ID を公開するには作成してください。",
        "columns": { "alias": "エイリアス", "kind": "種類", "targets": "ターゲット", "selection": "選択方法", "visibility": "モデル一覧", "actions": "操作" },
        "actions": { "create": "新規エイリアス", "refresh": "エイリアスを更新", "save": "保存", "saving": "保存中…", "delete": "削除", "deleting": "削除中…", "addTarget": "ターゲットを追加", "editNamed": "エイリアス {{name}} を編集", "deleteNamed": "エイリアス {{name}} を削除" },
        "dialog": { "createTitle": "エイリアスの作成", "editTitle": "エイリアスの編集：{{name}}" },
        "form": { "name": "エイリアス ID", "namePlaceholder": "my-alias-id", "displayName": "表示名", "displayPlaceholder": "任意の表示名", "kind": "種類", "selection": "選択方法", "visible": "/v1/models に表示" },
        "kind": { "chat": "チャット", "embedding": "埋め込み", "image": "画像" }, "selection": { "first": "最初に利用可能", "random": "ランダム" }, "visibility": { "visible": "表示", "hidden": "非表示" },
        "target": { "heading": "モデル", "description": "「最初に利用可能」では順番にターゲットを試します。候補を選択するか任意のモデル ID を入力できます。", "label": "ターゲット {{number}}", "modelId": "ターゲットモデル ID", "placeholder": "ターゲットモデル ID", "toggle": "ターゲットルールを切り替え", "moveUp": "ターゲットを上へ", "moveDown": "ターゲットを下へ", "remove": "ターゲットを削除", "count_one": "{{count}} ターゲット", "count_other": "{{count}} ターゲット" },
        "rules": { "effort": "推論エフォート", "budget": "推論予算トークン", "adaptive": "適応型推論", "adaptiveAuto": "自動（モデルに従う）", "adaptiveOn": "オン（適応型を強制）", "adaptiveOff": "オフ（非適応型を強制）", "summary": "推論サマリー", "verbosity": "詳細度", "serviceTier": "サービス階層" },
        "metadata": { "heading": "公開メタデータ", "description": "/v1/models がこのエイリアスについて報告する機能です。", "manual": "公開メタデータを手動で上書き", "limits": "トークン上限", "context": "コンテキストウィンドウ", "prompt": "プロンプトトークン", "output": "出力トークン", "modalities": "モダリティ", "imageInput": "画像入力", "reasoning": "推論", "effortEnabled": "エフォートレベル", "budgetEnabled": "予算トークン", "adaptive": "適応型", "mandatory": "必須", "efforts": "対応エフォート", "effortsHint": "カンマ区切り。順序は維持されます。", "defaultEffort": "デフォルトエフォート", "minBudget": "最小予算", "maxBudget": "最大予算" },
        "warnings": { "label": "エイリアス警告", "shadow": "エイリアス ID が実モデル {{id}} {{display}} を隠します。", "noTarget": "現在、このゲートウェイのモデルに解決できるターゲットがありません。", "unknownTarget": "{{id}} は現在、有効なモデルに解決できません。", "wrongKind": "{{id}} は {{actual}} モデルですが、このエイリアスは {{expected}} です。", "notAdvertisedEffort": "ターゲットは推論エフォートを公開していません。", "unsupportedEffort": "ターゲットが公開するエフォート：{{values}}。", "adaptiveBudgetConflict": "適応型推論と固定予算は併用できません。", "notAdvertisedBudget": "ターゲットは推論予算を公開していません。", "budgetBelow": "ターゲットの最小値（{{value}}）未満です。", "budgetAbove": "ターゲットの最大値（{{value}}）を超えています。", "notAdvertisedAdaptive": "ターゲットは適応型推論を公開していません。", "ruleAdvisory": "一部のルールはこのターゲットでサポートされない可能性があります。" },
        "validation": { "nameRequired": "エイリアス ID を入力してください。", "duplicate": "この ID のエイリアスは既に存在します。", "targetRequired": "すべてのターゲットにモデル ID が必要です。", "budget": "推論予算は 0 以上の整数である必要があります。", "adaptiveBudget": "適応型推論と固定予算は併用できません。", "metadataNumber": "メタデータのトークン値は 0 以上の整数である必要があります。", "metadataRange": "最大予算は最小予算以上である必要があります。" },
        "delete": { "title": "エイリアスの削除", "message": "エイリアス {{name}} を削除しますか？この操作は元に戻せません。" }, "errors": { "load": "エイリアスを読み込めませんでした。", "message": "エイリアス操作を完了できませんでした：{{message}}", "models": "モデルカタログを利用できません：{{message}}" }
      },
      "proxy": {
        "heading": "プロキシ",
        "description": "アップストリームのフォールバック一覧から参照される出口プロキシです。",
        "listTitle": "プロキシ一覧",
        "empty": "プロキシはまだありません。右側から追加してください。",
        "addTitle": "プロキシの追加",
        "editTitle": "プロキシの編集",
        "cancelEdit": "キャンセル",
        "form": {
          "name": "名前",
          "namePlaceholder": "マイプロキシ",
          "protocol": "プロトコル",
          "host": "ホスト",
          "hostPlaceholder": "server.example.com",
          "address": "アドレス",
          "port": "ポート",
          "username": "ユーザー名（任意）",
          "password": "パスワード（任意）",
          "method": "暗号化方式",
          "passwordLabel": "パスワード",
          "psk": "PSK（base64）",
          "sni": "SNI（任意の上書き）",
          "sniPlaceholder": "デフォルトではホスト名を使用",
          "allowInsecure": "証明書の検証をスキップ",
          "skipCertVerify": "証明書の検証をスキップ",
          "uuid": "UUID",
          "uuidPlaceholder": "00000000-0000-0000-0000-000000000000",
          "wsPath": "WebSocket パス",
          "wsPathPlaceholder": "/",
          "wsHost": "WS Host ヘッダー（任意）",
          "wsHostPlaceholder": "デフォルトではホスト名を使用",
          "serverName": "サーバー名（SNI）",
          "serverNamePlaceholder": "real.example.com",
          "publicKey": "公開鍵",
          "publicKeyPlaceholder": "x25519 公開鍵（base64url）",
          "shortId": "Short ID（任意）",
          "shortIdPlaceholder": "16 進数、最大 16 文字",
          "timeout": "接続タイムアウト",
          "timeoutPlaceholder": "デフォルト（10 秒）",
          "timeoutHint": "単位は秒です。空欄の場合はデフォルトの 10 秒を使用します。"
        },
        "actions": {
          "save": "プロキシの保存",
          "saving": "保存中…",
          "saveSuccess": "プロキシが保存されました。",
          "edit": "編集",
          "test": "テスト",
          "testing": "テスト中…",
          "delete": "削除",
          "deleting": "削除中…",
          "refresh": "更新"
        },
        "test": {
          "ok": "接続に成功しました",
          "egressIp": "出口 IP：{{ip}}",
          "failed": "テストに失敗しました：{{error}}"
        },
        "delete": {
          "title": "プロキシの削除",
          "message": "プロキシ {{name}} を削除しますか？この操作は元に戻せません。",
          "conflict": "削除できません：このプロキシはアップストリームから参照されています。",
          "conflictWithIds": "参照元のアップストリーム ID：{{ids}}"
        },
        "kind": {
          "HTTP": "HTTP",
          "HTTPS": "HTTPS",
          "SOCKS5": "SOCKS5",
          "SS": "Shadowsocks",
          "SS-2022": "Shadowsocks 2022",
          "TROJAN": "Trojan",
          "VLESS": "VLESS",
          "VLESS-WS": "VLESS-WS",
          "REALITY": "REALITY",
          "PROXY": "プロキシ"
        },
        "backoff": {
          "label": "{{count}} 件のバックオフ",
          "reset": "リセット",
          "resetting": "リセット中…",
          "none": "なし"
        },
        "timeout": {
          "default": "デフォルト",
          "seconds": "{{n}} 秒"
        }
      }
    },
    "validation": {
      "passwordRequired": "続行するにはパスワードを入力してください。",
      "passwordMax": "パスワードは 1024 文字以下である必要があります。",
      "usernamePattern": "ユーザー名は 0～64 文字で、英数字、アンダースコア、ピリオド、ハイフンのみ使用できます。"
    }
  }
} as const;

export default jaJP;
