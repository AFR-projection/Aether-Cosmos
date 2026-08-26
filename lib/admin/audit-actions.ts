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

export type AuditActionMeta = {
  label: string;
  description: string;
  icon: LucideIcon;
  tone: AuditTone;
  /** Which filter group the action belongs to in the logs toolbar. */
  group: "session" | "files" | "folders" | "users" | "security";
};

export const AUDIT_ACTIONS: Record<string, AuditActionMeta> = {
  login: { label: "Login", description: "User logged in", icon: LogIn, tone: "success", group: "session" },
  logout: { label: "Logout", description: "User logged out", icon: LogOut, tone: "muted", group: "session" },
  session_revoked: { label: "Session revoked", description: "A session was revoked", icon: LogOut, tone: "danger", group: "session" },

  upload: { label: "Upload", description: "File uploaded", icon: Upload, tone: "info", group: "files" },
  download: { label: "Download", description: "File downloaded", icon: Download, tone: "info", group: "files" },
  delete: { label: "Delete", description: "File deleted", icon: Trash2, tone: "danger", group: "files" },
  restore: { label: "Restore", description: "File restored from trash", icon: RotateCcw, tone: "success", group: "files" },
  share: { label: "Share", description: "File shared by link", icon: Share2, tone: "warning", group: "files" },
  edit: { label: "Edit", description: "File metadata edited", icon: Edit3, tone: "info", group: "files" },
  rename: { label: "Rename", description: "File renamed", icon: Edit3, tone: "info", group: "files" },
  move: { label: "Move", description: "File moved", icon: MoveRight, tone: "info", group: "files" },
  copy: { label: "Copy", description: "File copied", icon: Copy, tone: "info", group: "files" },
  favorite: { label: "Favorite", description: "File favorited", icon: Star, tone: "muted", group: "files" },

  create_folder: { label: "Create folder", description: "Folder created", icon: FolderPlus, tone: "success", group: "folders" },
  delete_folder: { label: "Delete folder", description: "Folder deleted", icon: FolderMinus, tone: "danger", group: "folders" },

  create_user: { label: "Create user", description: "New user created", icon: UserPlus, tone: "success", group: "users" },
  update_user: { label: "Update user", description: "User updated", icon: UserCog, tone: "info", group: "users" },
  delete_user: { label: "Delete user", description: "User deleted", icon: UserMinus, tone: "danger", group: "users" },
  suspend_user: { label: "Suspend user", description: "User suspended", icon: UserMinus, tone: "warning", group: "users" },
  impersonate: { label: "Impersonate", description: "Admin impersonated a user", icon: Shield, tone: "warning", group: "users" },

  account_lock: { label: "Account lock", description: "Account locked after failed logins", icon: Lock, tone: "danger", group: "security" },
  ip_rate_limit: { label: "IP rate limit", description: "An IP hit the login rate limit", icon: Globe, tone: "warning", group: "security" },
  password_change: { label: "Password change", description: "Password was changed", icon: KeyRound, tone: "accent", group: "security" },
};

/** Unknown action keys still render — they just get neutral chrome and their raw key. */
export function auditAction(action: string): AuditActionMeta {
  return (
    AUDIT_ACTIONS[action] ?? {
      label: action.replace(/_/g, " "),
      description: "Recorded activity",
      icon: Activity,
      tone: "muted",
      group: "session",
    }
  );
}

export const AUDIT_GROUPS: { id: AuditActionMeta["group"]; label: string; icon: LucideIcon }[] = [
  { id: "session", label: "Sessions", icon: LogIn },
  { id: "security", label: "Security", icon: Shield },
  { id: "files", label: "Files", icon: Upload },
  { id: "folders", label: "Folders", icon: FolderPlus },
  { id: "users", label: "Users", icon: Users },
];

/** Action keys belonging to a group, in registry order. */
export function actionsInGroup(group: AuditActionMeta["group"]): string[] {
  return Object.entries(AUDIT_ACTIONS)
    .filter(([, meta]) => meta.group === group)
    .map(([key]) => key);
}
