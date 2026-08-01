// src/config.js
const firebaseConfig = {
  apiKey:            process.env.FIREBASE_API_KEY            || "AIzaSyB6xQxFjiMM-jcYMjAMBQhDKM3HktswsNE",
  authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || "pre-order-80712.firebaseapp.com",
  projectId:         process.env.FIREBASE_PROJECT_ID         || "pre-order-80712",
  storageBucket:     process.env.FIREBASE_STORAGE_BUCKET     || "pre-order-80712.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "937214148740",
  appId:             process.env.FIREBASE_APP_ID             || "1:937214148740:web:d405a06c3ffd887ef482d1",
  // ── Realtime Database URL ──────────────────────────────
  // Firebase Console → Realtime Database → copy URL
  // Format: https://YOUR_PROJECT-default-rtdb.firebaseio.com
  rtdbUrl:           process.env.FIREBASE_RTDB_URL           || "https://pre-order-80712-default-rtdb.firebaseio.com",
};

module.exports = { firebaseConfig };