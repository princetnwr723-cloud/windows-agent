// src/agent/firestoreClient.js
// Firestore-based workspace pairing — replaces the RTDB-based
// connection handshake (agent registration, connect status, plan
// verification) which was unreliable in restrictive network
// environments because the hand-rolled RTDB SSE listener has no
// fallback when a firewall/AV silently drops the long-lived stream.
//
// Firestore's client SDK (onSnapshot) automatically falls back from
// WebSocket to long-polling when a WebSocket is blocked — this is
// exactly the resilience RTDB's raw SSE was missing.
//
// Uses Anonymous Auth so the agent has a REAL Firebase Auth session
// (request.auth != null), which lets us use much safer Firestore
// rules than RTDB's fully-open ".read/.write": true.

const { initializeApp }                                    = require("firebase/app");
const { getAuth, signInAnonymously, onAuthStateChanged }    = require("firebase/auth");
const {
  getFirestore, doc, setDoc, getDoc, onSnapshot, serverTimestamp,
} = require("firebase/firestore");

const { firebaseConfig } = require("../config");

let app, auth, db;
let authReadyPromise = null;

function init() {
  if (app) return;
  app = initializeApp({
    apiKey:            firebaseConfig.apiKey,
    authDomain:        firebaseConfig.authDomain,
    projectId:         firebaseConfig.projectId,
    storageBucket:     firebaseConfig.storageBucket,
    messagingSenderId: firebaseConfig.messagingSenderId,
    appId:             firebaseConfig.appId,
  });
  auth = getAuth(app);
  db   = getFirestore(app);

  authReadyPromise = new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        console.log(`🔐 [Firestore] Anonymous auth ready (${user.uid.slice(0, 8)}...)`);
        resolve(user);
      }
    });
    signInAnonymously(auth).catch((err) => {
      console.error("❌ [Firestore] Anonymous sign-in failed:", err.message);
      reject(err);
    });
  });
}

async function ready() {
  init();
  return authReadyPromise;
}

// ── Register / merge-update a workspace document ────────────
async function registerWorkspace(code, data) {
  await ready();
  const ref = doc(db, "agent_workspaces", code);
  await setDoc(ref, { ...data, updatedAt: serverTimestamp() }, { merge: true });
  console.log(`✅ [Firestore] Workspace written: agent_workspaces/${code}`);
}

async function updateWorkspace(code, data) {
  return registerWorkspace(code, data);
}

async function getWorkspace(code) {
  await ready();
  const snap = await getDoc(doc(db, "agent_workspaces", code));
  return snap.exists() ? snap.data() : null;
}

// ── Real-time listener — this is what replaces the flaky RTDB SSE ──
function watchWorkspace(code, onChange) {
  init();
  let unsub = () => {};
  ready().then(() => {
    unsub = onSnapshot(
      doc(db, "agent_workspaces", code),
      (snap) => { if (snap.exists()) onChange(snap.data()); },
      (err) => {
        console.error(`⚠️ [Firestore] watch error on ${code}:`, err.message, "— SDK auto-retries internally");
      }
    );
  });
  return () => unsub();
}

module.exports = { ready, registerWorkspace, updateWorkspace, getWorkspace, watchWorkspace };