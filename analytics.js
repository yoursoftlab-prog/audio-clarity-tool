// ══════════════════════════════════════════════════════════════
// analytics.js — Google Analytics 4 event logger.
//
// Loads gtag.js lazily (only once) and forwards events to GA4. Falls
// back to a console.debug no-op if GA4 isn't configured, so the app
// still runs fine locally / before you've set up a GA4 property.
//
// Setup:
//   1. Create a GA4 property at https://analytics.google.com
//   2. Copy its Measurement ID (looks like "G-XXXXXXXXXX")
//   3. Paste it into GA_MEASUREMENT_ID below
//
// Event names used across the app (see call sites in app.js,
// auth.js, payment.js):
//   login, logout, file_upload, audio_enhanced, download,
//   upgrade_clicked, payment_success, payment_failure
// ══════════════════════════════════════════════════════════════

// ⚠️ CONFIGURE ME — your GA4 Measurement ID, or leave blank to disable.
const GA_MEASUREMENT_ID = ""; // e.g. "G-DMPYH815BS"

let gtagReady = false;
let gtagLoading = null;

function loadGtag() {
  if (!GA_MEASUREMENT_ID) return Promise.resolve(false);
  if (gtagReady) return Promise.resolve(true);
  if (gtagLoading) return gtagLoading;

  gtagLoading = new Promise((resolve) => {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_MEASUREMENT_ID, { anonymize_ip: true });

    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    s.onload = () => { gtagReady = true; resolve(true); };
    s.onerror = () => { console.warn("[AudioClarity:analytics] gtag.js failed to load"); resolve(false); };
    document.head.appendChild(s);
  });
  return gtagLoading;
}

// Kick off loading as soon as this module is imported (non-blocking).
loadGtag();

export function trackEvent(name, params = {}) {
  console.debug("[AudioClarity:analytics]", name, params);
  if (!GA_MEASUREMENT_ID) return;
  if (window.gtag) {
    window.gtag("event", name, params);
  } else {
    loadGtag().then((ok) => { if (ok && window.gtag) window.gtag("event", name, params); });
  }
}
