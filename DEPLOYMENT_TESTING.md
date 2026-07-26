# Obfuscation + Testing — Audio Clarity

## 1. Obfuscation

Obfuscating `app.js`, `audio-engine.js`, `premium.js`, `payment.js` (per your
list) is fine as a deterrent against casual copy-paste, but it is **not**
real protection — none of your secrets live in these files anyway (they now
live server-side in Cloud Function secrets), so obfuscation here is purely
about making the JS harder to skim/clone, not about hiding anything sensitive.

```bash
npm install --save-dev javascript-obfuscator

npx javascript-obfuscator app.js          --output dist/app.js          --compact true --control-flow-flattening true
npx javascript-obfuscator audio-engine.js --output dist/audio-engine.js --compact true --control-flow-flattening true
npx javascript-obfuscator premium.js      --output dist/premium.js      --compact true --control-flow-flattening true
npx javascript-obfuscator payment.js      --output dist/payment.js      --compact true --control-flow-flattening true

# Leave these two as-is, copied unmodified into dist/:
cp firebase-config.js auth.js dist/
cp index.html analytics.js dist/   # analytics.js has no secrets either; obfuscate too if you like
```

Then point `index.html`'s `<script type="module" src="app.js">` at the `dist/`
build when you deploy, and **re-test everything in the checklist below against
the obfuscated build**, since `control-flow-flattening` occasionally trips up
edge cases (timers, `try/catch` ordering) — don't assume it behaves identically
to the source.

## 2. Manual testing checklist

Test on both **desktop** and **mobile**, across **Chrome, Edge, Firefox,
Safari**:

- [ ] **Google Sign-In** — popup/redirect completes, `users/{uid}` doc is
      created in Firestore on first login.
- [ ] **Sign out** — session clears, UI reverts to signed-out state.
- [ ] **5 free enhancements** — badge counts down correctly 5→0 across
      multiple files.
- [ ] **6th attempt** — blocked, "Upgrade" banner shown, `process-btn` stays
      disabled until upgrade or new sign-in with unused quota.
- [ ] **Premium purchase (Razorpay, simulate India)** — set your system
      timezone/locale to `Asia/Kolkata` or override `detectCurrency()`
      temporarily, use a Razorpay **test key + test card**, confirm
      `users/{uid}.premium` flips to `true` only after `verifyRazorpayPayment`
      succeeds.
- [ ] **Premium purchase (Stripe, simulate international)** — use a Stripe
      **test key + test card (4242 4242 4242 4242)**, confirm redirect back
      to `?payment=success`, and that `premium` only flips true after the
      **webhook** fires (check Stripe CLI `stripe listen --forward-to`
      during local testing).
- [ ] **Payment cancelled/failed** — closing the Razorpay modal or Stripe's
      cancel button returns you to the app with no premium granted, and
      `payment_failure` fires in analytics.
- [ ] **Premium user** — unlimited enhancements, badge shows "⭐ PREMIUM / ∞".
- [ ] **Connection error** — temporarily block Firestore (devtools network
      throttling / offline) and confirm the "Unable to connect" banner shows
      and processing is blocked rather than silently using stale state.
- [ ] **Firestore rules** — run through the 4 Rules Playground scenarios in
      `SECURITY_RULES.md` before going live.
- [ ] **Analytics** — open GA4 DebugView (or Realtime) and confirm `login`,
      `logout`, `file_upload`, `process_started`, `audio_enhanced`,
      `download`, `upgrade_clicked`, `payment_success`/`payment_failure` all
      appear.
- [ ] **SEO** — check rendered `<head>` with view-source once deployed;
      validate Open Graph tags with a tool like Facebook's Sharing Debugger,
      and replace the placeholder `og-image.png`/`favicon.ico` files.
- [ ] **Footer links** — `/privacy.html`, `/terms.html`, `/refund.html` all
      load (fill in the bracketed placeholders in each first).
