// ══════════════════════════════════════════════════════════════
// functions/index.js — Firebase Cloud Functions (2nd gen, Node 20).
//
// This is the ONLY code allowed to:
//   • hold Razorpay/Stripe/Anthropic secret keys, and
//   • write users/{uid}.premium = true in Firestore.
// The browser (payment.js, app.js) never does either.
//
// ── One-time setup ──────────────────────────────────────────────
//   cd functions && npm install
//   firebase functions:secrets:set RAZORPAY_KEY_ID
//   firebase functions:secrets:set RAZORPAY_KEY_SECRET
//   firebase functions:secrets:set STRIPE_SECRET_KEY
//   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
//   firebase functions:secrets:set ANTHROPIC_API_KEY
//   firebase deploy --only functions
//
// After deploying, copy the printed function URLs' common base
// (https://<region>-<project>.cloudfunctions.net) into
// FUNCTIONS_BASE_URL in firebase-config.js.
//
// Also set, in the Stripe Dashboard → Webhooks, an endpoint pointing
// at your deployed stripeWebhook URL, subscribed to
// checkout.session.completed.
// ══════════════════════════════════════════════════════════════
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const RAZORPAY_KEY_ID = defineSecret("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

// Must match firebase-config.js -> allowedHosts, so we only ever
// answer real front-end origins. (Server-side, this is enforced —
// unlike the client-side "speed bump" version in firebase-config.js.)
const ALLOWED_ORIGINS = new Set([
  "https://yoursoftlab.com",
  "https://www.yoursoftlab.com",
  "https://yoursoftlab-prog.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
]);

const PREMIUM_PRICE_INR_PAISE = 19900; // ₹199.00
const PREMIUM_PRICE_USD_CENTS = 199;   // $1.99

function withCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.status(204).send(""); return true; }
  return false;
}

// Verifies the Firebase ID token sent as "Authorization: Bearer <token>"
// and returns the decoded token (with .uid), or null if missing/invalid.
async function requireAuth(req, res) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) { res.status(401).json({ error: "Missing Authorization header" }); return null; }
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (err) {
    logger.warn("ID token verification failed", err);
    res.status(401).json({ error: "Invalid or expired session, please sign in again" });
    return null;
  }
}

// The only place premium ever gets flipped to true.
async function setPremium(uid, source, extra = {}) {
  await db.collection("users").doc(uid).set(
    { premium: true, premiumSince: admin.firestore.FieldValue.serverTimestamp(), premiumSource: source, ...extra },
    { merge: true }
  );
  logger.info(`Premium granted to ${uid} via ${source}`);
}

// ── Razorpay: create order ───────────────────────────────────────
exports.createRazorpayOrder = onRequest(
  { secrets: [RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET], cors: false },
  async (req, res) => {
    if (withCors(req, res)) return;
    const decoded = await requireAuth(req, res);
    if (!decoded) return;

    try {
      const auth = Buffer.from(`${RAZORPAY_KEY_ID.value()}:${RAZORPAY_KEY_SECRET.value()}`).toString("base64");
      const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
        body: JSON.stringify({
          amount: PREMIUM_PRICE_INR_PAISE,
          currency: "INR",
          receipt: `premium_${decoded.uid}_${Date.now()}`,
          notes: { uid: decoded.uid, product: "audio_clarity_premium" }
        })
      });
      const order = await rzpRes.json();
      if (!rzpRes.ok) throw new Error(order.error?.description || "Razorpay order creation failed");
      res.json({ id: order.id, amount: order.amount, currency: order.currency });
    } catch (err) {
      logger.error("createRazorpayOrder failed", err);
      res.status(500).json({ error: "Could not create order" });
    }
  }
);

// ── Razorpay: verify payment signature, THEN set premium ────────
exports.verifyRazorpayPayment = onRequest(
  { secrets: [RAZORPAY_KEY_SECRET], cors: false },
  async (req, res) => {
    if (withCors(req, res)) return;
    const decoded = await requireAuth(req, res);
    if (!decoded) return;

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ error: "Missing payment fields" });
      return;
    }

    const expected = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET.value())
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      logger.warn(`Razorpay signature mismatch for uid ${decoded.uid}`);
      res.status(400).json({ error: "Payment signature verification failed" });
      return;
    }

    await setPremium(decoded.uid, "razorpay", { razorpay_payment_id, razorpay_order_id });
    res.json({ ok: true });
  }
);

// ── Stripe: create Checkout Session ─────────────────────────────
exports.createStripeCheckoutSession = onRequest(
  { secrets: [STRIPE_SECRET_KEY], cors: false },
  async (req, res) => {
    if (withCors(req, res)) return;
    const decoded = await requireAuth(req, res);
    if (!decoded) return;

    const { successUrl, cancelUrl } = req.body || {};
    if (!successUrl || !cancelUrl) { res.status(400).json({ error: "Missing successUrl/cancelUrl" }); return; }

    try {
      const stripe = require("stripe")(STRIPE_SECRET_KEY.value());
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            unit_amount: PREMIUM_PRICE_USD_CENTS,
            product_data: { name: "Audio Clarity Premium — unlimited enhancements" }
          },
          quantity: 1
        }],
        client_reference_id: decoded.uid,
        metadata: { uid: decoded.uid },
        customer_email: decoded.email || undefined,
        success_url: successUrl,
        cancel_url: cancelUrl
      });
      res.json({ id: session.id });
    } catch (err) {
      logger.error("createStripeCheckoutSession failed", err);
      res.status(500).json({ error: "Could not create checkout session" });
    }
  }
);

// ── Stripe: webhook — the ONLY trigger for Stripe premium grants ─
// Configure this URL in the Stripe Dashboard, subscribed to
// checkout.session.completed. Stripe signs every request, so this
// is safe to trust even though it has no Firebase Auth token.
exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET], cors: false },
  async (req, res) => {
    const stripe = require("stripe")(STRIPE_SECRET_KEY.value());
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      // req.rawBody is provided by the Firebase Functions runtime.
      event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET.value());
    } catch (err) {
      logger.error("Stripe webhook signature verification failed", err);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.metadata?.uid || session.client_reference_id;
      if (uid) {
        await setPremium(uid, "stripe", { stripe_session_id: session.id });
      } else {
        logger.error("Stripe session completed with no uid in metadata", session.id);
      }
    }
    res.json({ received: true });
  }
);

// ── Anthropic proxy — generates the demo transcript server-side ─
// so the real API key never has to live in browser JS. Mirrors the
// prompt previously inline in app.js.
exports.generateTranscript = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: false },
  async (req, res) => {
    if (withCors(req, res)) return;
    const decoded = await requireAuth(req, res);
    if (!decoded) return;

    const { fileName, sizeMB } = req.body || {};
    try {
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `Generate a realistic demo transcript for audio file "${fileName}" (${sizeMB}MB). Respond ONLY with valid JSON, no markdown: {"raw":"...with um, uh, filler words...","enhanced":"...polished clean version..."}`
          }]
        })
      });
      const data = await aiRes.json();
      const txt = (data.content || []).map((c) => c.text || "").join("");
      const parsed = JSON.parse(txt.replace(/```json|```/g, "").trim());
      res.json({ raw: parsed.raw || "", enhanced: parsed.enhanced || "" });
    } catch (err) {
      logger.error("generateTranscript failed", err);
      res.status(500).json({ raw: "Transcript unavailable.", enhanced: "Transcript unavailable." });
    }
  }
);
