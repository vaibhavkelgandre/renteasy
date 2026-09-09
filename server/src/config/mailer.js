/**
 * The only module that knows how mail is delivered.
 *
 * It exports a FUNCTION, not a client or a transport object, and that is deliberate:
 * `{ to, subject, text }` is the exact intersection of every provider's send call, so
 * swapping providers later is a one-file change rather than a refactor of every
 * caller. Resist adding `cc`/`bcc` until something needs them — that is precisely
 * where providers diverge.
 *
 * Four behaviours. The first two are chosen by environment, the last two by whether
 * a provider is actually configured:
 *
 *   test                      → captured in an in-memory outbox that tests read
 *   development               → logged to the console, INCLUDING the link
 *   configured                → sent via Brevo over HTTPS
 *   production, unconfigured  → refuses, loudly
 *
 * Why the send decision is CONFIGURATION-driven rather than another NODE_ENV branch:
 * the reason to want real mail locally is to test against a real inbox. Keying that
 * on the environment would mean editing this file to do it. Paste a key into
 * `server/.env` and mail goes out; remove it and the console is the transport again.
 *
 * Why Brevo: the account already exists for another project on this machine, its free
 * tier is permanent (SendGrid's free access expires after two months and then simply
 * stops sending), and it verifies a single SENDER ADDRESS by email rather than
 * demanding an authenticated domain — which this project has no DNS access to
 * arrange. Resend was rejected for exactly that reason: without a verified domain it
 * delivers only to the account owner's own address, which is useless for emailing a
 * verification link to whoever just signed up.
 *
 * Deliberately no provider SDK. Brevo's transactional send is one JSON POST and
 * `fetch` is global in Node 18+, so a package would add a dependency and buy nothing.
 */

import { env } from "./env.js";

const SEND_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/**
 * A hung provider must not hold a request open indefinitely.
 *
 * Generous for a JSON POST, and it barely matters here: every send in this
 * application is fire-and-forget (see authService's `issueAndSendVerification`), so
 * this bounds a background promise rather than anyone's wait.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** @type {Array<{ to: string, subject: string, text: string, sentAt: Date }>} */
const outbox = [];

/**
 * Every message "sent" during a test run.
 *
 * The only way a test can obtain a raw verification token: the database stores just a
 * SHA-256 hash, so the token exists in exactly two places — the response to nothing,
 * and the email. This is how tests read it, and it is the same mechanism as
 * nodemailer's own test transport rather than a hole cut for the suite.
 *
 * @returns {typeof outbox}
 */
export function getOutbox() {
  return outbox;
}

/** Empties the outbox. Called between tests so one test cannot read another's mail. */
export function clearOutbox() {
  outbox.length = 0;
}

/**
 * Finds the most recent message sent to an address.
 *
 * @param {string} to
 * @returns {(typeof outbox)[number] | undefined}
 */
export function lastMailTo(to) {
  return [...outbox].reverse().find((mail) => mail.to.toLowerCase() === to.toLowerCase());
}

/**
 * Splits a `MAIL_FROM` string into the `{ email, name }` shape Brevo wants.
 *
 * `MAIL_FROM` is conventionally one RFC-5322 string, so parsing it here beats making
 * every deployment configure the same identity twice. A bare address is the common
 * case and passes straight through.
 *
 * Both quoting mistakes are ABSORBED rather than passed on, because a value that
 * literally contains quote characters is a known deployment error: dotenv strips one
 * surrounding pair from a `.env` file and a hosting dashboard stores it verbatim — so
 * the value that works locally arrives quoted in production. `"Name <addr>"` (the
 * whole thing quoted) and `"Name" <addr>` (only the display name, the RFC form) must
 * therefore both resolve to the same sender. A nodemailer-style parser turns the first
 * into the garbage address `"Name <addr"@example.com` and sends it anyway.
 *
 * Exported for its tests. Nothing else should call it.
 *
 * @param {string | undefined} value
 * @returns {{ email: string, name?: string } | null} Null when there is nothing to
 *          parse, which is what "unconfigured" looks like to `isMailConfigured`.
 */
export function parseMailFrom(value) {
  let raw = (value ?? "").trim();

  // Only a pair wrapping the ENTIRE value. The RFC form ends in `>`, so it is
  // untouched by this.
  const wrapped = raw.match(/^"(.*)"$/);
  if (wrapped) raw = wrapped[1].trim();
  if (!raw) return null;

  const angled = raw.match(/^(.*)<([^>]+)>\s*$/);
  if (!angled) return { email: raw };

  const name = angled[1].trim().replace(/^"(.*)"$/, "$1").trim();
  const email = angled[2].trim();
  return name ? { email, name } : { email };
}

/**
 * Whether there is enough configuration to attempt a real send.
 *
 * CHECKS BOTH THE KEY AND THE SENDER, together. Brevo rejects a send whose sender is
 * not verified, so a half-filled environment — the most common `.env` state — would
 * otherwise read as configured and fail on every single send, instead of falling back
 * to the console. Two of two, never one of two.
 *
 * @returns {boolean}
 */
export function isMailConfigured() {
  return Boolean(env.brevoApiKey && parseMailFrom(env.mailFrom));
}

/**
 * One line describing how mail will actually behave, for the startup banner.
 *
 * This exists because "mail is not configured" is invisible until the first person
 * fails to receive a verification link, by which time it looks like a bug in
 * registration. Says it at boot instead.
 *
 * @returns {string}
 */
export function describeMailMode() {
  if (env.isTest) return "in-memory outbox (test) — nothing is sent";
  if (isMailConfigured()) return `Brevo, sending as ${parseMailFrom(env.mailFrom).email}`;
  if (env.isDevelopment) return "console only — no provider configured, links are printed below";
  return "NOT CONFIGURED — mail will NOT be sent. Set BREVO_API_KEY and MAIL_FROM";
}

/**
 * POSTs one message to Brevo.
 *
 * @param {{ to: string, subject: string, text: string }} message
 * @returns {Promise<boolean>} True — it either reached the provider or threw.
 * @throws {Error} On a network failure, the timeout, or any non-2xx.
 */
async function sendViaBrevo({ to, subject, text }) {
  const payload = {
    sender: parseMailFrom(env.mailFrom),
    to: [{ email: to }],
    subject,
    // Always a text part. A message with no text part is scored as spam and renders
    // blank in text-only clients. There is no HTML part yet — these two emails are
    // plain instructions and a link, and an HTML shell would be a mail-client
    // compatibility problem taken on for no gain. `html` is the next key to add here.
    textContent: text,
  };

  let response;
  try {
    response = await fetch(SEND_ENDPOINT, {
      method: "POST",
      headers: {
        // `api-key`, NOT `Authorization: Bearer`. A bearer token fails as a 401,
        // which reads as a bad key rather than as the wrong scheme.
        "api-key": env.brevoApiKey,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // `fetch` rejects only on a network-level failure or the timeout above; an HTTP
    // error status resolves normally and is handled below. Both become one thrown
    // Error so callers see a single failure shape.
    throw new Error(`Mail provider unreachable: ${error.message}`);
  }

  // Any 2xx is success and the body goes unread: Brevo answers 201 with a messageId
  // nothing here needs. `response.ok` rather than a specific code survives the
  // provider adding, say, 200.
  //
  // A failure body carries Brevo's own error text, which is the only way to tell a bad
  // key from an unverified sender — surface it, because that distinction is exactly
  // what the log line needs to be useful. Truncated: it is provider output going into
  // a log, and the useful part is at the front.
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Mail provider rejected the message (${response.status}): ${detail.slice(0, 500)}`
    );
  }

  return true;
}

/**
 * Sends a message.
 *
 * @param {object} message
 * @param {string} message.to
 * @param {string} message.subject
 * @param {string} message.text Plain text. Every message ships one — a mail with no
 *        text part scores as spam and renders blank in text-only clients.
 * @returns {Promise<boolean>} True only when the message actually reached a
 *          transport. Callers that tell a human "we emailed them" depend on this
 *          distinction — do not re-derive it from `isMailConfigured()` at a call site.
 * @throws {Error} If a configured provider rejects or is unreachable. Every caller in
 *         this application already answers that with "log it and carry on" — see
 *         authService, where an awaited send would also add a timing signal on top of
 *         the one registration goes to such lengths to remove.
 */
export async function sendMail({ to, subject, text }) {
  // FIRST, AND UNCONDITIONALLY. env.js calls dotenv.config() on import, so a
  // BREVO_API_KEY present in `.env` and absent from `.env.test` still lands in
  // process.env during a test run — real credentials are visible to the suite whether
  // we like it or not. Without this guard ahead of every other branch, one test
  // touching a mail path without stubbing this module would send real email to
  // whatever address a fixture invented.
  if (env.isTest) {
    outbox.push({ to, subject, text, sentAt: new Date() });
    return true;
  }

  if (env.isDevelopment) {
    // THE LINK IS LOGGED HERE, AND ONLY HERE.
    //
    // In development that is the point — there is no inbox to check, and the
    // alternative is reading the token out of the database, which is impossible
    // because only its hash is stored. Printed even when a provider IS configured, so
    // that pasting a key does not cost you the convenience.
    //
    // In production this would be a genuine leak: the log would publish working
    // single-use credentials to anyone who can read it. That is why the branch is on
    // NODE_ENV and why production refuses to send rather than falling back to this.
    console.log(`\n[mail:dev] To: ${to}\n[mail:dev] ${subject}\n${text}\n`);
  }

  if (!isMailConfigured()) {
    // In development the console above WAS the transport, so this is a real send as
    // far as the caller is concerned.
    if (env.isDevelopment) return true;

    // Production with no provider. Refuse rather than silently discard: an
    // unverifiable account is a broken signup, and a swallowed send makes it look
    // like the user's fault. Never log the body here — see the dev branch above.
    console.error(`[mail] No provider configured. Not sent: "${subject}" to ${to}`);
    return false;
  }

  // ⚠️ Brevo has NO PER-SEND TRACKING SWITCH, and that is a real reduction in what
  // this file can guarantee. Click tracking rewrites every href into a provider
  // redirect — and every link this application mails is a single-use credential, so
  // that would route a live token through a third party and destroy the one property
  // letting a recipient tell a real email from phishing: a visible link to the domain
  // the mail claims to come from. On Brevo it is an ACCOUNT-LEVEL dashboard setting,
  // so it must be switched off there and cannot be enforced from here. Recorded rather
  // than glossed over.
  return sendViaBrevo({ to, subject, text });
}
