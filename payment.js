// ══════════════════════════════════════════════════════════════
// payment.js — "Upgrade to Premium" flow.
//
// Razorpay (India) + Stripe Checkout (international). Client code
// NEVER sets premium:true — it only asks a Cloud Function to create
// an order/session, then hands off to the provider's UI. The actual
// premium:true write happens in functions/index.js, from trusted
// server code, after the provider confirms payment
// (Razorpay: signature verify via Cloud Function;
//  Stripe: checkout.session.completed webhook).
//
// Deploy the Cloud Functions in functions/index.js, then set
// FUNCTIONS_BASE_URL below to your deployed functions' base URL,
// e.g. "https://us-central1-yoursoftlab-f7246.cloudfunctions.net".
// ══════════════════════════════════════════════════════════════
import { trackEvent } from "./analytics.js";
import { FUNCTIONS_BASE_URL } from "./firebase-config.js";

// ⚠️ CONFIGURE ME — public/publishable keys only (safe for client-side).
// Secret keys (Razorpay key_secret, Stripe secret key) live ONLY in
// functions/index.js as Cloud Function environment config, never here.
const RAZORPAY_KEY_ID = "rzp_live_XXXXXXXXXXXX";
const STRIPE_PUBLISHABLE_KEY = "pk_live_XXXXXXXXXXXXXXXXXXXXXXXX";

let stripePromise = null;
function loadStripeJs() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (stripePromise) return stripePromise;
  stripePromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.onload = () => resolve(window.Stripe);
    s.onerror = () => reject(new Error("Failed to load Stripe.js"));
    document.head.appendChild(s);
  });
  return stripePromise;
}

let razorpayPromise = null;
function loadRazorpayJs() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (razorpayPromise) return razorpayPromise;
  razorpayPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(window.Razorpay);
    s.onerror = () => reject(new Error("Failed to load Razorpay Checkout"));
    document.head.appendChild(s);
  });
  return razorpayPromise;
}

async function callFunction(path, body, idToken) {
  const res = await fetch(`${FUNCTIONS_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {})
    },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Server error (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}

function showUpgradeError(msg) {
  alert(msg || "Something went wrong starting the payment. Please try again.");
}

// ── India: Razorpay Checkout ─────────────────────────────────────
async function startRazorpay(user) {
  await loadRazorpayJs();
  const idToken = await user.getIdToken();

  // 1. Ask our Cloud Function to create a Razorpay order (needs the
  //    secret key, so it can't happen in this file).
  const order = await callFunction("createRazorpayOrder", {}, idToken);

  return new Promise((resolve, reject) => {
    const rzp = new window.Razorpay({
      key: RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      order_id: order.id,
      name: "Audio Clarity",
      description: "Premium — unlimited enhancements",
      prefill: {
        name: user.displayName || "",
        email: user.email || ""
      },
      theme: { color: "#8B5CF6" },
      handler: async (response) => {
        try {
          // 2. Hand the signed payment response to a Cloud Function,
          //    which verifies the Razorpay signature server-side and
          //    ONLY THEN sets users/{uid}.premium = true.
          await callFunction("verifyRazorpayPayment", {
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature
          }, idToken);
          trackEvent("payment_success", { provider: "razorpay" });
          resolve();
        } catch (err) {
          trackEvent("payment_failure", { provider: "razorpay", reason: "verify_failed" });
          reject(err);
        }
      },
      modal: {
        ondismiss: () => {
          trackEvent("payment_failure", { provider: "razorpay", reason: "dismissed" });
          reject(new Error("Payment cancelled."));
        }
      }
    });
    rzp.on("payment.failed", (resp) => {
      trackEvent("payment_failure", { provider: "razorpay", reason: resp?.error?.description || "unknown" });
      reject(new Error(resp?.error?.description || "Payment failed."));
    });
    rzp.open();
  });
}

// ── International: Stripe Checkout ───────────────────────────────
async function startStripe(user) {
  const idToken = await user.getIdToken();

  // Ask our Cloud Function to create a Checkout Session (needs the
  // secret key, so it can't happen in this file). It embeds the
  // signed-in uid so the webhook knows whose premium flag to flip.
  const session = await callFunction("createStripeCheckoutSession", {
    successUrl: window.location.origin + window.location.pathname + "?payment=success",
    cancelUrl: window.location.origin + window.location.pathname + "?payment=cancelled"
  }, idToken);

  const Stripe = await loadStripeJs();
  const stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
  const { error } = await stripe.redirectToCheckout({ sessionId: session.id });
  // Stripe's actual premium:true write happens later, server-side, in
  // the stripeWebhook Cloud Function once it gets
  // checkout.session.completed — NOT here and NOT on redirect return.
  if (error) throw error;
}

// Called once on page load (see app.js) to pick up a Stripe redirect
// back with ?payment=success — just refreshes usage/premium state
// from Firestore rather than trusting the URL itself.
export function checkPaymentRedirect() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("payment");
  if (!status) return;
  if (status === "success") {
    trackEvent("payment_success", { provider: "stripe", stage: "redirect" });
  } else if (status === "cancelled") {
    trackEvent("payment_failure", { provider: "stripe", reason: "cancelled" });
  }
  params.delete("payment");
  const clean = window.location.pathname + (params.toString() ? "?" + params.toString() : "");
  window.history.replaceState({}, "", clean);
  window.dispatchEvent(new CustomEvent("ac-request-refresh"));
}

export async function initiateUpgrade() {
  const AC = window.AudioClarityAuth;
  const st = AC ? AC.getState() : {};
  if (!st.user) { showUpgradeError("Please sign in first."); return; }

  const currency = AC.getCurrency ? AC.getCurrency() : { code: "USD" };
  trackEvent("upgrade_clicked", { currency: currency.code });

  try {
    if (currency.code === "INR") {
      await startRazorpay(st.user);
      // Razorpay verification is synchronous from the client's point
      // of view, so ask app.js/auth.js to re-read Firestore now.
      window.dispatchEvent(new CustomEvent("ac-request-refresh"));
    } else {
      await startStripe(st.user);
      // Stripe redirects away; premium picks up via checkPaymentRedirect()
      // + refresh when the user lands back on successUrl.
    }
  } catch (err) {
    console.error("[AudioClarity] Upgrade failed:", err);
    showUpgradeError(err.message || "Payment could not be completed.");
  }
}
