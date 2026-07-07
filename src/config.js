// Vnus Agent Config
// Fill these with your actual values

const firebaseConfig = {
  apiKey: "AIzaSyB6xQxFjiMM-jcYMjAMBQhDKM3HktswsNE",
  authDomain: "pre-order-80712.firebaseapp.com",
  projectId: "pre-order-80712",
  storageBucket: "pre-order-80712.firebasestorage.app",
  messagingSenderId: "937214148740",
  appId: "1:937214148740:web:d405a06c3ffd887ef482d1",
};

// Aerolink API key — get from aerolink.lat/dashboard
// Format: aero_live_...
const aerolinkConfig = {
  apiKey: "aero_live_RX7IPtsP5uvLwYkks9fV_JvUKLoELPn2gdT9yvYXEXc",
  baseUrl: "https://capi.aerolink.lat",
  model: "claude-sonnet-4-6",
};

module.exports = { firebaseConfig, aerolinkConfig };