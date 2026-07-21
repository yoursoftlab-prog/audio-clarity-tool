# Firestore Security Rules — Audio Clarity

Paste the rules below into **Firestore Database → Rules** in the Firebase
Console (or `firestore.rules` if you deploy via the CLI), then click
**Publish**.

## Why these rules matter

- `users/{uid}.premium` must **only ever** be set to `true` by the Cloud
  Functions in `functions/index.js`, which use the **Admin SDK**. The Admin
  SDK bypasses Firestore security rules entirely — so these rules only need
  to stop the *client* (a signed-in user's own browser) from writing
  `premium`, not stop the Cloud Functions.
- Everything else (`displayName`, `photoURL`, `lastLogin`) is fine for the
  client to update on sign-in, per `premium.js`'s `ensureUserDoc()`.
- `usage/{uid}` (free-trial counter) is readable/writable by its own owner,
  but `freeUsed` can only ever *increase* from client writes (never reset or
  decreased), so a malicious client can't zero out its own usage count.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── users/{uid} ──────────────────────────────────────────
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;

      // Creation on first sign-in: premium must start false.
      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.data.premium == false;

      // Updates: owner only, and 'premium' must be unchanged from
      // whatever it already was in the stored document. Only the
      // Cloud Functions (Admin SDK, which ignores these rules) may
      // flip it to true.
      allow update: if request.auth != null
        && request.auth.uid == uid
        && request.resource.data.premium == resource.data.premium;

      allow delete: if false;
    }

    // ── usage/{uid} ──────────────────────────────────────────
    match /usage/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;

      allow create: if request.auth != null
        && request.auth.uid == uid
        && request.resource.data.freeUsed == 0;

      // freeUsed may only increase (client-side increment(1) calls);
      // it can never be reset or decreased from the client.
      allow update: if request.auth != null
        && request.auth.uid == uid
        && request.resource.data.freeUsed is int
        && request.resource.data.freeUsed >= resource.data.freeUsed;

      allow delete: if false;
    }

    // Everything else: locked down by default.
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## Test this before you rely on it

In the Firebase Console: **Firestore → Rules → Rules Playground** — simulate:

1. An authenticated user (`request.auth.uid == "abc"`) trying to
   `update` `users/abc` with `{ premium: true }` while the stored
   document has `premium: false` → should be **DENIED**.
2. The same user updating `users/abc` with `{ displayName: "New Name" }`
   (premium field omitted/unchanged) → should be **ALLOWED**.
3. A different user (`request.auth.uid == "xyz"`) trying to read or write
   `users/abc` → should be **DENIED**.
4. A user trying to `update` `usage/abc` with a lower `freeUsed` than
   currently stored → should be **DENIED**.

If any of these come back the wrong way, don't deploy — fix the rule first.
