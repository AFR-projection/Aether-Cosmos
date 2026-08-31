import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { eq } from "drizzle-orm";
import { deliverMail } from "./mailer";
import { loginAlertEmail, passwordChangedEmail, accountLockedEmail } from "./templates";

/**
 * Email is this app's primary contact channel, so account/security events are
 * pushed to the user's registered address in users.email. Users without an
 * email on file are silently skipped (nothing to deliver to).
 */

/** Format an instant as a readable WIB (Asia/Jakarta) timestamp. */
function formatTime(date: Date): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jakarta",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date) + " WIB"
  );
}

type NotifyEvent =
  | {
      type: "login";
      at: Date;
      ip?: string | null;
      device?: string | null;
      location?: string | null;
    }
  | { type: "password_changed"; at: Date }
  | { type: "account_locked"; minutes: number };

/**
 * Send a security notification to a user over email. Fire-and-forget: never
 * throws and never blocks the calling request — a mail outage must not break
 * login, password change, etc. Callers may `void notifyUser(...)`.
 */
export async function notifyUser(userId: string, event: NotifyEvent): Promise<void> {
  try {
    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const email = user?.email?.trim();
    if (!email) return;

    let subject: string;
    let html: string;
    let text: string;
    switch (event.type) {
      case "login":
        ({ subject, html, text } = loginAlertEmail({
          time: formatTime(event.at),
          ip: event.ip,
          device: event.device,
          location: event.location,
        }));
        break;
      case "password_changed":
        ({ subject, html, text } = passwordChangedEmail(formatTime(event.at)));
        break;
      case "account_locked":
        ({ subject, html, text } = accountLockedEmail(event.minutes));
        break;
    }

    await deliverMail({ to: email, subject, html, text });
  } catch (err) {
    console.error(`[MAIL] notifyUser failed (${userId}):`, err);
  }
}
