import {
  Activity,
  Copy,
  Download,
  Edit3,
  FolderMinus,
  FolderPlus,
  Globe,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  MoveRight,
  RotateCcw,
  Share2,
  Shield,
  Star,
  Trash2,
  Upload,
  UserMinus,
  UserPlus,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { TranslationKey, Translator } from "@/shared/lib/i18n/dictionary";

/**
 * The one description of what an audit action means.
 *
 * This used to exist three times: `actionIcons` + `actionColors` on the overview
 * page and a separate `actionConfig` on the logs page, which had drifted apart —
 * the same event showed up violet in one place and cyan in the other, and the two
 * maps disagreed on which icon `restore` used.
 *
 * `tone` is deliberately coarse. Twenty-three distinct hues told an operator
 * nothing; five semantic buckets tell them where to look:
 *
 * - `danger`   — something was destroyed, or a security control fired
 * - `warning`  — a privileged action that deserves a second look
 * - `success`  — an account or object was created, or a login succeeded
 * - `info`     — routine file traffic
 * - `muted`    — background noise (logouts)
 */
export type AuditTone = "accent" | "success" | "warning" | "danger" | "info" | "muted";

/**
 * The two readable strings are keys, not text: the same event is read by an
 * operator working in English, Indonesian or Chinese, and a registry that stored
 * prose would have pinned all three to the first one.
 */
export type AuditActionMeta = {
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: LucideIcon;
  tone: AuditTone;
  /** Which filter group the action belongs to in the logs toolbar. */
  group: "session" | "files" | "folders" | "users" | "security";
};

export const AUDIT_ACTIONS: Record<string, AuditActionMeta> = {
  login: { labelKey: "admin.audit.action.login", descriptionKey: "admin.audit.description.login", icon: LogIn, tone: "success", group: "session" },
  logout: { labelKey: "admin.audit.action.logout", descriptionKey: "admin.audit.description.logout", icon: LogOut, tone: "muted", group: "session" },
  session_revoked: { labelKey: "admin.audit.action.sessionRevoked", descriptionKey: "admin.audit.description.sessionRevoked", icon: LogOut, tone: "danger", group: "session" },

  upload: { labelKey: "admin.audit.action.upload", descriptionKey: "admin.audit.description.upload", icon: Upload, tone: "info", group: "files" },
  download: { labelKey: "admin.audit.action.download", descriptionKey: "admin.audit.description.download", icon: Download, tone: "info", group: "files" },
  delete: { labelKey: "admin.audit.action.delete", descriptionKey: "admin.audit.description.delete", icon: Trash2, tone: "danger", group: "files" },
  restore: { labelKey: "admin.audit.action.restore", descriptionKey: "admin.audit.description.restore", icon: RotateCcw, tone: "success", group: "files" },
  share: { labelKey: "admin.audit.action.share", descriptionKey: "admin.audit.description.share", icon: Share2, tone: "warning", group: "files" },
  edit: { labelKey: "admin.audit.action.edit", descriptionKey: "admin.audit.description.edit", icon: Edit3, tone: "info", group: "files" },
  rename: { labelKey: "admin.audit.action.rename", descriptionKey: "admin.audit.description.rename", icon: Edit3, tone: "info", group: "files" },
  move: { labelKey: "admin.audit.action.move", descriptionKey: "admin.audit.description.move", icon: MoveRight, tone: "info", group: "files" },
  copy: { labelKey: "admin.audit.action.copy", descriptionKey: "admin.audit.description.copy", icon: Copy, tone: "info", group: "files" },
  favorite: { labelKey: "admin.audit.action.favorite", descriptionKey: "admin.audit.description.favorite", icon: Star, tone: "muted", group: "files" },

  create_folder: { labelKey: "admin.audit.action.createFolder", descriptionKey: "admin.audit.description.createFolder", icon: FolderPlus, tone: "success", group: "folders" },
  delete_folder: { labelKey: "admin.audit.action.deleteFolder", descriptionKey: "admin.audit.description.deleteFolder", icon: FolderMinus, tone: "danger", group: "folders" },

  create_user: { labelKey: "admin.audit.action.createUser", descriptionKey: "admin.audit.description.createUser", icon: UserPlus, tone: "success", group: "users" },
  update_user: { labelKey: "admin.audit.action.updateUser", descriptionKey: "admin.audit.description.updateUser", icon: UserCog, tone: "info", group: "users" },
  delete_user: { labelKey: "admin.audit.action.deleteUser", descriptionKey: "admin.audit.description.deleteUser", icon: UserMinus, tone: "danger", group: "users" },
  suspend_user: { labelKey: "admin.audit.action.suspendUser", descriptionKey: "admin.audit.description.suspendUser", icon: UserMinus, tone: "warning", group: "users" },
  impersonate: { labelKey: "admin.audit.action.impersonate", descriptionKey: "admin.audit.description.impersonate", icon: Shield, tone: "warning", group: "users" },

  account_lock: { labelKey: "admin.audit.action.accountLock", descriptionKey: "admin.audit.description.accountLock", icon: Lock, tone: "danger", group: "security" },
  ip_rate_limit: { labelKey: "admin.audit.action.ipRateLimit", descriptionKey: "admin.audit.description.ipRateLimit", icon: Globe, tone: "warning", group: "security" },
  password_change: { labelKey: "admin.audit.action.passwordChange", descriptionKey: "admin.audit.description.passwordChange", icon: KeyRound, tone: "accent", group: "security" },
};

/** Unknown action keys still render — they just get neutral chrome and their raw key. */
export function auditAction(action: string): AuditActionMeta {
  return (
    AUDIT_ACTIONS[action] ?? {
      labelKey: "admin.audit.action.unknown",
      descriptionKey: "admin.audit.description.unknown",
      icon: Activity,
      tone: "muted",
      group: "session",
    }
  );
}

/**
 * The label to show for a stored action. A key the registry knows is translated;
 * one it does not is humanised from the raw column value, which says more to the
 * operator than a generic word would.
 */
export function auditActionLabel(action: string, t: Translator): string {
  const meta = AUDIT_ACTIONS[action];
  return meta ? t(meta.labelKey) : action.replace(/_/g, " ");
}

export const AUDIT_GROUPS: {
  id: AuditActionMeta["group"];
  labelKey: TranslationKey;
  icon: LucideIcon;
}[] = [
  { id: "session", labelKey: "admin.audit.group.session", icon: LogIn },
  { id: "security", labelKey: "admin.audit.group.security", icon: Shield },
  { id: "files", labelKey: "admin.audit.group.files", icon: Upload },
  { id: "folders", labelKey: "admin.audit.group.folders", icon: FolderPlus },
  { id: "users", labelKey: "admin.audit.group.users", icon: Users },
];

/** Action keys belonging to a group, in registry order. */
export function actionsInGroup(group: AuditActionMeta["group"]): string[] {
  return Object.entries(AUDIT_ACTIONS)
    .filter(([, meta]) => meta.group === group)
    .map(([key]) => key);
}
