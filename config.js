// 學習羅盤 LearnCompass 設定檔
// 這個檔案同時給網頁與 Service Worker（推播）使用，請照 SETUP.md 的步驟填入。
// 這些值本來就是公開給瀏覽器用的，放在公開的 GitHub 上是安全的；
// 真正保護資料的是 firestore.rules。
self.LC_CONFIG = {
  // Firebase 主控台 > 專案設定 > 一般 > 你的應用程式 > SDK 設定
  // 留空（null）時，網頁會以「本機模式」運作，資料只存在這台裝置。
  firebase: null,
  // 範例：
  // firebase: {
  //   apiKey: "AIza...",
  //   authDomain: "your-project.firebaseapp.com",
  //   projectId: "your-project",
  //   storageBucket: "your-project.appspot.com",
  //   messagingSenderId: "1234567890",
  //   appId: "1:1234567890:web:abcdef"
  // },

  // Firebase 主控台 > 專案設定 > Cloud Messaging > 網路設定 > 網路推播憑證 的「金鑰組」
  vapidKey: ""
};
