# 學習羅盤 LearnCompass：設定教學

整套服務都是免費方案，只要照順序做一次就好。大約需要 30 分鐘。

| 用途 | 服務 |
| --- | --- |
| 網頁／手機 APP | GitHub Pages |
| 雲端資料同步、Google 登入 | Firebase（Firestore、Authentication） |
| 每天早上 8 點推播提醒 | GitHub Actions ＋ Firebase Cloud Messaging |

> 還沒設定 Firebase 前，網頁會以「本機模式」運作，可以先匯入 CSV 試用。資料只存在那台電腦的瀏覽器裡。

---

## 第 1 步：建立 Firebase 專案

1. 到 <https://console.firebase.google.com>，用您的 Google 帳號登入，按「建立專案」。
2. 專案名稱輸入 `learn-compass`（或任何名稱）。Google Analytics 可以關閉。
3. 進入專案後，按左上「⚙ 專案設定」→「一般」→ 下方「你的應用程式」→ 點 **</>（網頁）** 圖示。
   - 應用程式暱稱：`學習羅盤`，**不要**勾選 Firebase Hosting，按「註冊應用程式」。
   - 畫面會出現一段 `const firebaseConfig = { ... }`，先留著這個頁面，第 4 步會用到。

## 第 2 步：開啟 Google 登入

1. 左側選單「建構」→ **Authentication** →「開始使用」。
2. 「登入方式」分頁 → 選 **Google** → 啟用 → 選擇支援電子郵件 → 儲存。
3. 「設定」分頁 →「已授權網域」→「新增網域」，輸入 `您的GitHub帳號.github.io`（第 6 步完成後就會知道帳號名稱）。

## 第 3 步：建立 Firestore 資料庫

1. 左側「建構」→ **Firestore Database** →「建立資料庫」。
2. 位置選 `asia-east1（台灣）`，模式選「以正式版模式啟動」。
3. 建好後切到「規則」分頁，把內容整個換成本資料夾裡 `firestore.rules` 的內容，按「發布」。
   （這個規則確保每個人只能讀寫自己的資料。）

## 第 4 步：填寫 config.js

1. 用記事本打開 `config.js`。
2. 把 `firebase: null,` 換成第 1 步看到的設定，例如：

   ```js
   firebase: {
     apiKey: "AIza...",
     authDomain: "learn-compass-xxxx.firebaseapp.com",
     projectId: "learn-compass-xxxx",
     storageBucket: "learn-compass-xxxx.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abcdef"
   },
   ```

3. 推播金鑰：Firebase「⚙ 專案設定」→ **Cloud Messaging** 分頁 → 最下方「網路設定」→「網路推播憑證」→ 按「產生金鑰組」，複製那串長長的金鑰，貼到 `vapidKey: "這裡"`。

> 這些值本來就是給瀏覽器用的公開資訊，放在公開的 GitHub 上是安全的。

## 第 5 步：建立推播用的服務帳戶金鑰（不可公開）

1. Firebase「⚙ 專案設定」→ **服務帳戶** 分頁 →「產生新的私密金鑰」→ 會下載一個 `.json` 檔。
2. **這個檔案等同密碼，千萬不要放進 LearnCompass 資料夾或上傳到 GitHub。** 先存在桌面，第 7 步用完就刪除。

## 第 6 步：用 GitHub Desktop 發布網站

1. 打開 GitHub Desktop，選擇 LearnCompass 這個 repository（若還沒加入：File → Add local repository → 選這個資料夾）。
2. 左下角填寫 Summary：`第一版`，按 **Commit to main**。
3. 按上方 **Publish repository**：
   - 取消勾選「Keep this code private」（免費帳號的 GitHub Pages 需要公開 repository；您的課程資料存在 Firebase，不會出現在 GitHub 上）。
   - 按 Publish。
4. 到 GitHub 網站上的這個 repository →「Settings」→ 左側「Pages」：
   - Source：`Deploy from a branch`，Branch：`main`、資料夾 `/ (root)` → Save。
   - 約 1～2 分鐘後，上方會顯示網址，例如 `https://您的帳號.github.io/LearnCompass/`。
5. 回到第 2 步第 3 點，把 `您的帳號.github.io` 加入 Firebase 已授權網域。

## 第 7 步：設定每日推播（GitHub Actions）

在 GitHub 上的 repository →「Settings」→「Secrets and variables」→「Actions」：

1. **Secrets** 分頁 →「New repository secret」
   - Name：`FIREBASE_SERVICE_ACCOUNT`
   - Secret：用記事本打開第 5 步下載的 `.json`，**全選複製**整份內容貼上 → Add secret。
   - 完成後就可以把桌面上的 `.json` 檔刪除。
2. **Variables** 分頁 →「New repository variable」
   - Name：`APP_URL`
   - Value：第 6 步得到的網址，例如 `https://您的帳號.github.io/LearnCompass/`

## 第 8 步：開始使用

### 電腦
1. 打開網址 → 用 Google 登入。
2. 按「匯入」→ 選擇 `夢想地圖_2026-09-29.csv`。系統會自動從備註辨識上課場次，例如天賦啟動計劃的 6 堂課。

### iPhone（需要 iOS 16.4 以上）
1. 用 **Safari** 打開網址 → 下方「分享」→「加入主畫面」。
2. 從主畫面的「學習羅盤」圖示打開 → 用 Google 登入。
3. 「設定」→「在這台裝置開啟推播」→ 允許通知。

### Android
1. 用 **Chrome** 打開網址 → 登入 →「設定」→「安裝成 APP」（或右上「⋮」→「安裝應用程式」）。
2. 從主畫面打開 →「設定」→「在這台裝置開啟推播」→ 允許通知。

### 測試推播
GitHub 上的 repository →「Actions」→ 左側「每日學習提醒」→ 右側「Run workflow」→ 勾選「送一則測試通知給所有裝置」→ Run。
大約 1 分鐘內，手機應該會收到「推播測試成功！」。

---

## 第 9 步：開啟筆記附件（圖片與檔案存到 Google 雲端硬碟）

附件會存到你自己 Google 雲端硬碟裡的「學習羅盤」資料夾，不用付費。APP 只會申請 **drive.file** 權限，意思是它**只能看到自己上傳的檔案**，看不到你雲端硬碟裡的其他東西。

以下網址都會直接打開你的 Firebase 專案（learn-compass-b63b1）對應的 Google Cloud 頁面，請用建立 Firebase 的同一個 Google 帳號登入。

### 9-1 啟用 Google Drive API
1. 打開 https://console.cloud.google.com/apis/library/drive.googleapis.com?project=learn-compass-b63b1
2. 按藍色的「**啟用**」。已經顯示「管理」就代表啟用好了。

### 9-2 加入雲端硬碟權限
1. 打開 https://console.cloud.google.com/auth/scopes?project=learn-compass-b63b1 （左側選單「資料存取權」）。
2. 按「**新增或移除範圍**」。
3. 在右側清單上方的篩選框輸入 `drive.file`，勾選
   `.../auth/drive.file`（說明是「查看、編輯、建立及刪除您透過這個應用程式使用的 Google 雲端硬碟檔案」）。
4. 按最下方「**更新**」，再按頁面最下方「**Save**／儲存」。

> 如果頁面要你先設定「品牌宣傳」（應用程式名稱、支援電子郵件）：應用程式名稱填「學習羅盤」，電子郵件選你的 Gmail，其他留空，儲存後再回來做第 2 步。

### 9-3 讓自己可以授權
1. 打開 https://console.cloud.google.com/auth/audience?project=learn-compass-b63b1 （左側選單「目標對象」）。
2. 看「發布狀態」：
   - 如果是「**測試中**」：往下找「測試使用者」→「**Add users**／新增使用者」→ 輸入你的 Gmail → 儲存。
   - 如果已經是「**正式版**」：不用動。
3. 第一次連結時，Google 可能會顯示「**Google 尚未驗證這個應用程式**」。這是因為 APP 是你自己做的，按「**進階**」→「**前往學習羅盤（不安全）**」即可。

### 9-4 允許網站使用並取得「用戶端 ID」
1. 打開 https://console.cloud.google.com/auth/clients?project=learn-compass-b63b1 （左側選單「用戶端」）。
2. 點名稱為「**Web client (auto created by Google Service)**」的那一個（Firebase 自動建立的）。
3. 在「**已授權的 JavaScript 來源**」按「新增 URI」，加入這兩個（一行一個，結尾不要加 `/`）：
   - `https://chuboa.github.io`
   - `http://localhost:8080`（讓我在你電腦上測試用，可以不加）
4. 按最下方「**儲存**」。設定生效最多可能要幾分鐘。
5. 同一頁右側（或上方）有「**用戶端 ID**」，長得像 `701770077294-xxxxxxxx.apps.googleusercontent.com`，按旁邊的複製圖示。
   - ⚠️ 只要複製「用戶端 ID」。**「用戶端密鑰」（Client secret）不要複製、不要給任何人**，這個 APP 用不到它。

### 9-5 填入 config.js 並上線
1. 用記事本打開 `config.js`，找到：
   ```js
   googleClientId: "",
   ```
   把剛剛複製的用戶端 ID 貼在兩個引號中間，例如：
   ```js
   googleClientId: "701770077294-xxxxxxxx.apps.googleusercontent.com",
   ```
2. 存檔 → GitHub Desktop 左下 Summary 填「設定雲端硬碟」→ **Commit to main** → **Push origin**。
3. 等 1～2 分鐘，打開 APP 的「設定」→「Google 雲端硬碟」→「**連結雲端硬碟**」→ 選你的帳號 → 允許。
4. 打開任何一篇筆記，按工具列最前面的「圖片」或「迴紋針」圖示，就能加入附件。

### 使用說明
- **圖片**：手機可直接拍照或從相簿選；電腦可拖曳圖片到筆記上，或直接貼上截圖（Ctrl+V）。圖片會自動壓縮成長邊 1600 像素，筆記裡另存一張小縮圖，所以沒網路也看得到縮圖。
- **檔案**：PDF、Word、Excel 等都可以，每個最多 20 MB，每篇筆記最多 30 個附件。點檔案會在 Google 雲端硬碟中打開。
- **沒網路時**：附件先存在這台裝置，顯示「尚未上傳」，連線後自動上傳。
- **授權每次約 1 小時**：這是 Google 的安全規定。過期後要上傳或看原圖時，APP 會顯示「連結並上傳」按鈕，按一下就好（通常不用再選帳號）。
- **刪除附件或筆記**：雲端硬碟裡的檔案會移到**垃圾桶**，30 天內都能從雲端硬碟救回。

---

## 提醒規則

都可以在 APP 的「設定」頁調整：

- **觀看權限到期**：到期前 30、7、3、1 天，以及到期當天各推播一次（只提醒還沒學完的課）。
- **直播／實體課**：上課前一天與當天早上 8 點推播。在課程的「編輯」裡可新增上課場次。
- **久未學習**：每週一推播一次摘要，列出超過 14 天沒有更新學習能量的課程。
  拖動卡片上的「學習能量」就會記錄為最近一次學習。

## 常見問題

- **改了 config.js 或程式後手機沒更新？** APP 會先用快取開啟，背景下載新版；關掉 APP 再打開一次就會是新版。
- **iPhone 登入時一直轉圈？** 請確認第 2 步的「已授權網域」已加入 `您的帳號.github.io`。若仍不行，先用 Safari（不是主畫面 APP）登入一次再試。
- **推播突然停了？** 公開 repository 若連續 60 天沒有任何更新，GitHub 會自動暫停排程；到「Actions」頁面按「Enable workflow」即可恢復。
- **密碼鎖：** 「設定」→「密碼鎖」可以設定 4～6 位數字密碼，也可以隨時變更或取消。密碼只存在那台裝置，每台手機、電腦各自設定。忘記密碼時，按鎖定畫面的「忘記？」，登出後用 Google 重新登入即可（雲端模式）。
- **想要備份？** 「備份」→「下載完整備份（JSON）」。日後可用「匯入」還原。
- **重新產生圖示：** `powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1`
