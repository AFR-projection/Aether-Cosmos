import nodemailer, { type Transporter } from "nodemailer";
import { db } from "@/shared/infrastructure/db";
import { mailSenders } from "@/shared/infrastructure/db/schema";
import { decryptSecret } from "./crypto";
import { recordEmailLog } from "./log";
import { getRouterConfig, selectSenders, noteSuccess, noteFailure } from "./router";

/**
 * Gmail SMTP delivery layer. Each mail_senders row is a Gmail account + App
 * Password; we open a short-lived nodemailer transport per send. Transports are
 * cached by sender id (keyed also on a fingerprint of the credentials so a
 * password change invalidates the cache) to avoid re-handshaking on every OTP.
 */

const GMAIL_HOST = "smtp.gmail.com";
const GMAIL_PORT = 465; // implicit TLS

type CachedTransport = { fingerprint: string; transport: Transporter };
const transportCache = new Map<string, CachedTransport>();

function fingerprint(email: string, appPassword: string): string {
  // Cheap change-detector; not a secret store. Length + first/last keeps it
  // out of logs while still changing when the credential rotates.
  return `${email}:${appPassword.length}:${appPassword.slice(0, 2)}${appPassword.slice(-2)}`;
}

function buildTransport(email: string, appPassword: string): Transporter {
  return nodemailer.createTransport({
    host: GMAIL_HOST,
    port: GMAIL_PORT,
    secure: true,
    auth: { user: email, pass: appPassword },
    // Bound the handshake/send so a firewalled VPS fails fast instead of hanging
    // the HTTP request behind it (mirrors the WhatsApp client's bounded queries).
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function transportFor(id: string, email: string, appPassword: string): Transporter {
  const fp = fingerprint(email, appPassword);
  const cached = transportCache.get(id);
  if (cached && cached.fingerprint === fp) return cached.transport;
  cached?.transport.close();
  const transport = buildTransport(email, appPassword);
  transportCache.set(id, { fingerprint: fp, transport });
  return transport;
}

/** Drop a cached transport (call on sender delete / password change). */
export function evictTransport(id: string): void {
  transportCache.get(id)?.transport.close();
  transportCache.delete(id);
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Open an SMTP connection and authenticate WITHOUT sending mail. Used by the
 * admin panel to give an immediate green/red status when a sender is saved.
 * App Passwords that are wrong (or 2FA not enabled) fail here with a clear error.
 */
export async function verifyCredentials(email: string, appPassword: string): Promise<VerifyResult> {
  const startedAt = Date.now();
  try {
    const transport = buildTransport(email, appPassword);
    await transport.verify();
    transport.close();
    recordEmailLog("info", "verify", `SMTP credentials OK for ${email}`, {
      email,
      durationMs: Date.now() - startedAt,
    });
    return { ok: true };
  } catch (err) {
    const error = friendlyError(err);
    recordEmailLog("error", "verify", `SMTP verification failed for ${email}`, {
      email,
      durationMs: Date.now() - startedAt,
      error,
    });
    return { ok: false, error };
  }
}

export type SendArgs = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

/**
 * The subset of nodemailer's SMTP `SentMessageInfo` we log for diagnostics.
 * `accepted`/`rejected`/`response` are the verdict of the SENDING relay
 * (smtp.gmail.com), NOT proof of inbox delivery: Gmail can accept a message
 * here (250 ...gsmtp) and then silently spam-file or drop it downstream. So a
 * clean 250 here + "user never got it" points at filtering, not this app.
 */
type SmtpSentInfo = {
  messageId?: string;
  response?: string;
  accepted?: unknown;
  rejected?: unknown;
};

/** Nodemailer reports accepted/rejected as strings or {address} objects; flatten to strings. */
function addrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) =>
    typeof x === "string"
      ? x
      : x && typeof x === "object" && "address" in x
        ? String((x as { address: unknown }).address)
        : String(x)
  );
}

/** Send via a specific sender row. Returns false on any failure (never throws). */
export async function sendViaSender(
  sender: { id: string; email: string; appPasswordEncrypted: string; fromName: string },
  args: SendArgs
): Promise<boolean> {
  let appPassword: string;
  try {
    appPassword = decryptSecret(sender.appPasswordEncrypted);
  } catch (err) {
    recordEmailLog("error", "send", `Cannot decrypt App Password for ${sender.email}`, {
      email: sender.email,
      senderId: sender.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  const startedAt = Date.now();
  try {
    const transport = transportFor(sender.id, sender.email, appPassword);
    const info = (await transport.sendMail({
      from: { name: sender.fromName, address: sender.email },
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    })) as SmtpSentInfo;

    const accepted = addrList(info.accepted);
    const rejected = addrList(info.rejected);
    // nodemailer throws when a single recipient is rejected, so a resolved send
    // normally means the relay took it. We still surface rejected/partial cases
    // as a warning instead of a clean "Sent".
    const recipientTaken =
      accepted.length === 0 ||
      accepted.some((a) => a.toLowerCase() === args.to.toLowerCase());

    recordEmailLog(
      rejected.length > 0 || !recipientTaken ? "warn" : "info",
      "send",
      `Sent "${args.subject}" to ${args.to} via ${sender.email}`,
      {
        to: args.to,
        via: sender.email,
        senderId: sender.id,
        messageId: info.messageId,
        // Literal 250 line from smtp.gmail.com. "250 ... OK ... gsmtp" == Gmail
        // QUEUED it; if the user still never receives it, the loss is downstream
        // (spam/phishing filtering), not in this app.
        smtpResponse: info.response,
        accepted,
        rejected,
        durationMs: Date.now() - startedAt,
      }
    );
    return true;
  } catch (err) {
    recordEmailLog("error", "send", `Send failed to ${args.to} via ${sender.email}`, {
      to: args.to,
      via: sender.email,
      senderId: sender.id,
      durationMs: Date.now() - startedAt,
      error: friendlyError(err),
    });
    // A stale transport (e.g. Gmail dropped the socket) should not stick around.
    evictTransport(sender.id);
    return false;
  }
}

/**
 * Deliver a message using the smart router: pick eligible senders (respecting
 * daily caps + cooldowns, least-recently-used first), try them in order, and
 * record success/failure accounting so the pool self-balances and self-heals.
 * Returns true as soon as one sender accepts the message.
 */
export async function deliverMail(args: SendArgs): Promise<boolean> {
  const now = Date.now();
  const cfg = await getRouterConfig();

  const all = await db.select().from(mailSenders);
  const activeTotal = all.filter((s) => s.isActive).length;
  const eligible = selectSenders(all, cfg, now);

  if (eligible.length === 0) {
    recordEmailLog(
      "warn",
      "deliver",
      `No eligible sender for "${args.subject}" to ${args.to}`,
      {
        to: args.to,
        activeSenders: activeTotal,
        totalSenders: all.length,
        hint:
          activeTotal === 0
            ? "no active sender configured"
            : "all active senders are on cooldown or at their daily limit",
      }
    );
    return false;
  }

  let attempted = 0;
  for (const sender of eligible) {
    attempted++;
    const ok = await sendViaSender(sender, args);
    if (ok) {
      await noteSuccess(sender, now);
      if (attempted > 1) {
        recordEmailLog("info", "deliver", `Delivered via failover to ${sender.email} (attempt ${attempted})`, {
          to: args.to,
          via: sender.email,
        });
      }
      return true;
    }
    await noteFailure(sender, cfg, now);
  }

  recordEmailLog("error", "deliver", `All eligible senders failed to deliver "${args.subject}" to ${args.to}`, {
    to: args.to,
    sendersTried: attempted,
    eligibleSenders: eligible.length,
    totalSenders: all.length,
  });
  return false;
}

/** Turn a nodemailer/SMTP error into a short, admin-readable string. */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Invalid login|535|BadCredentials|Username and Password not accepted/i.test(msg)) {
    return "Gmail rejected the login. Check the email and make sure you used a 16-character App Password (not your normal password), with 2-Step Verification enabled.";
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|timeout/i.test(msg)) {
    return "Could not reach smtp.gmail.com. Outbound SMTP (port 465) may be blocked on this server.";
  }
  return msg.slice(0, 300);
}
