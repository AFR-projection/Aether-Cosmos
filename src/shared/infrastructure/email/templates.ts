/**
 * All transactional email copy lives here so tone + branding stay consistent.
 * Every template returns both an HTML body and a plain-text fallback (some
 * clients and spam filters penalize HTML-only mail). Keep copy short and clear.
 */

import { APP_NAME } from "@/shared/lib/app-version";

const APP = APP_NAME;
const BRAND = "#6366f1";

/** Shared HTML shell: centered card, brand header, muted footer. */
function shell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ececf1;">
          <tr><td style="background:${BRAND};padding:20px 28px;">
            <span style="color:#fff;font-size:16px;font-weight:700;letter-spacing:.2px;">${APP}</span>
          </td></tr>
          <tr><td style="padding:28px;">
            <h1 style="margin:0 0 12px;font-size:18px;color:#18181b;">${title}</h1>
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:0 28px 28px;">
            <p style="margin:0;font-size:12px;color:#a1a1aa;">This is an automated message from ${APP}. Please do not reply.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function otpEmail(code: string, minutes: number): { subject: string; html: string; text: string } {
  const subject = `${code} is your ${APP} verification code`;
  const html = shell(
    "Verify your email",
    `<p style="margin:0 0 16px;font-size:14px;color:#3f3f46;line-height:1.5;">
       Use this code to verify your email. It is valid for ${minutes} minutes. Do not share it with anyone.
     </p>
     <div style="margin:8px 0 4px;padding:16px;text-align:center;background:#f4f4f7;border-radius:12px;">
       <span style="font-size:34px;font-weight:700;letter-spacing:8px;color:${BRAND};font-family:monospace;">${code}</span>
     </div>`
  );
  const text = `${APP}\n\nYour verification code is: ${code}\nIt is valid for ${minutes} minutes. Do not share it with anyone.`;
  return { subject, html, text };
}

export function loginAlertEmail(opts: {
  time: string;
  ip?: string | null;
  device?: string | null;
  location?: string | null;
}): { subject: string; html: string; text: string } {
  const rows: string[] = [`<b>Time:</b> ${opts.time}`];
  if (opts.ip) rows.push(`<b>IP:</b> ${opts.ip}`);
  if (opts.device) rows.push(`<b>Device:</b> ${opts.device}`);
  if (opts.location) rows.push(`<b>Location:</b> ${opts.location}`);
  const html = shell(
    "New sign-in detected",
    `<p style="margin:0 0 12px;font-size:14px;color:#3f3f46;line-height:1.6;">${rows.join("<br>")}</p>
     <p style="margin:0;font-size:13px;color:#71717a;">If this wasn't you, change your password immediately.</p>`
  );
  const textLines = [`${APP}`, ``, `New sign-in detected.`, ``, `Time: ${opts.time}`];
  if (opts.ip) textLines.push(`IP: ${opts.ip}`);
  if (opts.device) textLines.push(`Device: ${opts.device}`);
  if (opts.location) textLines.push(`Location: ${opts.location}`);
  textLines.push(``, `If this wasn't you, change your password immediately.`);
  return { subject: `New sign-in to your ${APP} account`, html, text: textLines.join("\n") };
}

export function passwordChangedEmail(time: string): { subject: string; html: string; text: string } {
  const html = shell(
    "Your password was changed",
    `<p style="margin:0 0 12px;font-size:14px;color:#3f3f46;line-height:1.6;"><b>Time:</b> ${time}</p>
     <p style="margin:0;font-size:13px;color:#71717a;">If this wasn't you, contact the administrator immediately.</p>`
  );
  const text = `${APP}\n\nYour password was just changed.\n\nTime: ${time}\n\nIf this wasn't you, contact the administrator immediately.`;
  return { subject: `Your ${APP} password was changed`, html, text };
}

export function accountLockedEmail(minutes: number): { subject: string; html: string; text: string } {
  const html = shell(
    "Account temporarily locked",
    `<p style="margin:0 0 12px;font-size:14px;color:#3f3f46;line-height:1.6;">
       Your account was locked after several failed sign-in attempts. You can try again in ${minutes} minutes.
     </p>
     <p style="margin:0;font-size:13px;color:#71717a;">If this wasn't you, change your password.</p>`
  );
  const text = `${APP}\n\nYour account has been temporarily locked after several failed sign-in attempts.\n\nYou can try again in ${minutes} minutes. If this wasn't you, change your password.`;
  return { subject: `${APP} account locked`, html, text };
}
