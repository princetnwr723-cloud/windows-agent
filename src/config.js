// src/config.js
// Vnus Agent Config

const firebaseConfig = {
  apiKey:            "AIzaSyB6xQxFjiMM-jcYMjAMBQhDKM3HktswsNE",
  authDomain:        "pre-order-80712.firebaseapp.com",
  projectId:         "pre-order-80712",
  storageBucket:     "pre-order-80712.firebasestorage.app",
  messagingSenderId: "937214148740",
  appId:             "1:937214148740:web:d405a06c3ffd887ef482d1",
};

// Agent secret — shared between agent and Next.js API
const agentSecret = "vnus-agent-secret-change-in-prod";

// Aerolink / backend base URL
const aerolinkConfig = {
  baseUrl: "https://vnus.ai",
};

module.exports = { firebaseConfig, agentSecret, aerolinkConfig };