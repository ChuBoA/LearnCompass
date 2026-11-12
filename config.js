// 學習羅盤 LearnCompass 設定檔
// 這個檔案同時給網頁與 Service Worker（推播）使用，請照 SETUP.md 的步驟填入。
// 這些值本來就是公開給瀏覽器用的，放在公開的 GitHub 上是安全的；
// 真正保護資料的是 firestore.rules。
self.LC_CONFIG = {
  // Firebase 主控台 > 專案設定 > 一般 > 你的應用程式 > SDK 設定
  // 留空（null）時，網頁會以「本機模式」運作，資料只存在這台裝置。
  firebase: {
  apiKey: "AIzaSyCTy7xoI67OuydfKglTGWwFeunKdGwQYQI",
  authDomain: "learn-compass-b63b1.firebaseapp.com",
  projectId: "learn-compass-b63b1",
  storageBucket: "learn-compass-b63b1.firebasestorage.app",
  messagingSenderId: "701770077294",
  appId: "1:701770077294:web:63cf253fec69decce9c27f"
  } ,
  // 範例：
  // firebase: {
  //   apiKey: "AIza...",
  //   authDomain: "your-project.firebaseapp.com",
  //   projectId: "your-project",
  //   storageBucket: "your-project.appspot.com",
  //   messagingSenderId: "1234567890",
  //   appId: "1:1234567890:web:abcdef"
  // },

  // 筆記的圖片與檔案存到 Google 雲端硬碟：Google Cloud 主控台 > API 和服務 > 憑證 > OAuth 2.0 用戶端 ID
  // 形如 "1234567890-xxxxxxxx.apps.googleusercontent.com"；留空就不能加附件（SETUP.md 第 9 步）
  googleClientId: "",

  // Firebase 主控台 > 專案設定 > Cloud Messaging > 網路設定 > 網路推播憑證 的「金鑰組」
  vapidKey: "BAqcytn_kbmhKdh5-osOHjn2U8G-sSetuf4G70cX-19qNnL66PMOJPZ7hxEClPmERIVlAvDYWTLTcNZW6-qqqs0"
};
