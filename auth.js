// ══════════════════════════════════════════════════════════════
// auth.js — Firebase init + Google Sign-In. Free-trial/premium
// tracking itself lives in premium.js; this file wires Firebase Auth
// to it and exposes a single public API on window.AudioClarityAuth
// that app.js consumes.
// ══════════════════════════════════════════════════════════════
import { firebaseConfig, FREE_LIMIT, isConfigured, runOriginGate } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getState, detectCurrency, refreshUsage, canProcess, recordUsage } from "./premium.js";

window.FREE_LIMIT = FREE_LIMIT; // exposed for app.js's badge/limit UI code
runOriginGate(); // shows the "Unauthorized Copy" overlay off-domain

const configured = isConfigured();

let app, auth, db;
if (configured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} else {
  console.warn("[AudioClarity] Firebase config not set — running in local demo mode (usage stored only in this browser, not enforced across devices).");
}

window.AudioClarityAuth = {
  isConfigured: () => configured,
  getState,
  getCurrency: detectCurrency,
  // Opens the Google Sign-In popup. Firestore user/usage docs are
  // created afterwards by onAuthStateChanged → refreshUsage, so
  // sign-in itself only needs to handle the popup + auth result.
  signIn: async () => {
    if (!configured) { alert("Firebase isn't configured yet — see the setup comment at the top of firebase-config.js."); return; }
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      getState().connectionError = false;
    } catch (err) {
      // Don't treat the user simply closing the popup as a connection
      // problem — only surface the network-error banner for genuine
      // connectivity failures.
      if (err && (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request")) {
        console.warn("[AudioClarity] Sign-in popup dismissed:", err.code);
      } else {
        console.error("[AudioClarity] Sign-in failed:", err);
        getState().connectionError = true;
      }
      window.dispatchEvent(new CustomEvent("ac-state-changed"));
    }
  },
  signOutUser: async () => {
    if (!configured) return;
    try {
      await signOut(auth);
      getState().connectionError = false;
    } catch (err) {
      console.error("[AudioClarity] Sign-out failed:", err);
      getState().connectionError = true;
    }
    window.dispatchEvent(new CustomEvent("ac-state-changed"));
  },
  canProcess,
  recordUsage: () => recordUsage(db)
};

// Fires on page load (restoring an existing session) AND right after
// a fresh sign-in/sign-out — this single listener covers both
// auto-restoring the session on load and saving the user to Firestore
// on sign-in, with no duplicated logic.
if (configured) {
  onAuthStateChanged(auth, async (user) => {
    getState().user = user;
    if (user) await refreshUsage(db, configured, user); // also runs ensureUserDoc internally, sets connectionError on failure
    window.dispatchEvent(new CustomEvent("ac-state-changed"));
  });
}
