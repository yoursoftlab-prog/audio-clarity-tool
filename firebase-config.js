// ══════════════════════════════════════════════════════════════
// FIREBASE SETUP — fill in your own project's config below.
// Create a project at https://console.firebase.google.com, enable:
//   • Authentication → Sign-in method → Google
//   • Firestore Database (production mode) with the security rules
//     from SECURITY_RULES.md in this same folder
// Then paste your web app config here (Project settings → General
// → Your apps → SDK setup and configuration).
// ══════════════════════════════════════════════════════════════
export const firebaseConfig = {
  apiKey: "AIzaSyC3brllXZwel_VBT8P34vog1L1UgDdbY0I",
  authDomain: "yoursoftlab-f7246.firebaseapp.com",
  projectId: "yoursoftlab-f7246",
  storageBucket: "yoursoftlab-f7246.firebasestorage.app",
  messagingSenderId: "183223578478",
  appId: "1:183223578478:web:4b2c00feaed0c129385b7f",
  measurementId: "G-DMPYH815BS"
};

// Hostnames this app is allowed to run from. Add your GitHub Pages
// domain (e.g. "yourusername.github.io"). This is a *client-side*
// convenience gate only — it deters casual copy-paste re-hosting,
// but anyone can delete this file from a saved copy, so it is NOT
// real access control. Real enforcement has to happen server-side
// (e.g. a Cloud Function checking the request's Origin header
// before doing anything sensitive, like verifying a payment).
// Treat this purely as a friendly speed bump.
//export const allowedHosts = ["https://github.com/yoursoftlab-prog/audio_clarity_tool"];
export const allowedHosts = [
  "yoursoftlab-f7246.web.app",
  "yoursoftlab-f7246.firebaseapp.com",
  "audioclarity.in",
  "www.audioclarity.in",
  "localhost",
  "127.0.0.1"
];
// Number of free enhancements a signed-in, non-premium account gets.
// Tracked in Firestore at usage/{uid} — see the main app script.
export const FREE_LIMIT = 5;

// Base URL of your deployed Cloud Functions (see functions/index.js).
// Used for: creating Razorpay orders / Stripe Checkout sessions
// (payment.js), and generating the demo transcript server-side
// (app.js) so the Anthropic API key never has to sit in browser JS.
// Format: https://<region>-<projectId>.cloudfunctions.net
export const FUNCTIONS_BASE_URL = "https://us-central1-yoursoftlab-f7246.cloudfunctions.net";

// True once you've replaced the placeholder apiKey above with a
// real one. While false, the app runs in local demo mode (no
// Firebase project needed) so you can still test the UI.
export function isConfigured() {
  return !!(firebaseConfig && firebaseConfig.apiKey !== "YOUR_API_KEY");
}

// Shows the "Unauthorized Copy" overlay if this page is running on
// a hostname that isn't in allowedHosts. See the comment on
// allowedHosts above — this is a deterrent, not real security.
//export function runOriginGate() {
  //const host = location.hostname;
  //if (!allowedHosts.includes(host)) {
    //document.addEventListener("DOMContentLoaded", () => {
      //const el = document.getElementById("unauthorized-overlay");
      //if (el) el.style.display = "flex";
    //});
  //}
//}
export function runOriginGate() {
  const host = window.location.hostname;

  // Allow local development
  if (host === "localhost" || host === "127.0.0.1") {
    return;
  }

  // Allow official domains
  if (allowedHosts.includes(host)) {
    return;
  }

  // Block all other domains
  window.addEventListener("DOMContentLoaded", () => {
    const overlay = document.getElementById("unauthorized-overlay");
    if (overlay) {
      overlay.style.display = "flex";
    }
  });
}
