"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MotionConfig, motion } from "framer-motion";
import {
  Hash,
  Info,
  KeyRound,
  Laptop,
  Monitor,
  Moon,
  Palette,
  Shield,
  Sun,
  UserRound,
} from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { apiFetch } from "@/lib/api/client";
import { APP_NAME, APP_VERSION_LABEL } from "@/lib/app-version";
import { formatBytes } from "@/lib/utils";
import {
  PasswordSection,
  StepCodeSection,
  TwoFactorSection,
} from "@/components/account/account-security-sections";
import { SessionsSection } from "@/components/settings/sessions-section";
import { rememberCurrentSessionId } from "@/hooks/use-realtime-events";
import {
  setLitePreference,
  useLiteMode,
  useLitePreference,
  type LitePreference,
} from "@/lib/system/lite-mode";

interface SessionUser {
  id: string;
  username: string;
  role: string;
  quotaBytes: number;
  usedBytes: number;
  email?: string | null;
  totpEnabled?: boolean;
  sessionId?: string;
}

/** Expo.out, the easing the design system uses everywhere on this page. */
const EASE = [0.16, 1, 0.3, 1] as const;

type SectionId =
  | "password"
  | "step-code"
  | "2fa"
  | "profile"
  | "appearance"
  | "devices"
  | "about";

const GROUPS = ["Security", "Account", "System"] as const;

type Section = {
  id: SectionId;
  group: (typeof GROUPS)[number];
  title: string;
  description: string;
  icon: typeof KeyRound;
};

/**
 * Declared once at module scope, not rebuilt per render, and holding no JSX —
 * the panel is looked up by id and mounted on its own. The old page built an
 * array of seven live elements every render, so every section (including the
 * two that fetch) was mounted even while collapsed.
 */
const SECTIONS: readonly Section[] = [
  { id: "password", group: "Security", title: "Password", description: "Change the password you sign in with.", icon: KeyRound },
  { id: "step-code", group: "Security", title: "2-Step Code", description: "A numeric code asked for after your password.", icon: Hash },
  { id: "2fa", group: "Security", title: "Two-factor app", description: "Authenticator codes and one-time recovery codes.", icon: Shield },
  { id: "profile", group: "Account", title: "Profile", description: "Account details and how much storage you have used.", icon: UserRound },
  { id: "appearance", group: "Account", title: "Appearance", description: "Theme, and how much visual effect to load.", icon: Palette },
  { id: "devices", group: "Account", title: "Devices", description: "Where this account is signed in, and how to sign it out.", icon: Laptop },
  { id: "about", group: "System", title: "About", description: `${APP_NAME} ${APP_VERSION_LABEL}`, icon: Info },
];

export default function SettingsPage() {
  const { data: user, isLoading } = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const res = await apiFetch<SessionUser>("/api/auth/login");
      if (!res.success || !res.data) throw new Error(res.error ?? "Not authenticated");
      rememberCurrentSessionId(res.data.sessionId);
      return res.data;
    },
  });

  if (isLoading) return <SettingsSkeleton />;
  if (!user) return null;

  return <SettingsContent user={user} />;
}

function SettingsContent({ user }: { user: SessionUser }) {
  const [active, setActive] = useState<SectionId>("password");
  const current = SECTIONS.find((section) => section.id === active) ?? SECTIONS[0];
  const CurrentIcon = current.icon;

  return (
    <MotionConfig reducedMotion="user">
      <div className="set-page">
        <header className="set-header">
          <div className="set-header__copy">
            <p className="set-kicker">
              <span aria-hidden="true" />
              Account settings
            </p>
            <h1>Settings</h1>
            <p>
              Security, appearance and the devices signed in to this account.
              Choose a section to open it — the others stay out of the way.
            </p>
          </div>
          <IdentityChip user={user} />
        </header>

        <div className="set-body">
          <nav className="set-nav" aria-label="Settings sections">
            {GROUPS.map((group) => (
              <div key={group} className="set-nav__group">
                <p className="set-nav__label">{group}</p>
                {SECTIONS.filter((section) => section.group === group).map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className="set-nav__item"
                    data-active={section.id === active}
                    aria-current={section.id === active || undefined}
                    aria-controls="settings-panel"
                    onClick={() => setActive(section.id)}
                  >
                    <section.icon aria-hidden="true" />
                    <span className="set-nav__text">{section.title}</span>
                    {section.id === "2fa" && (
                      <span className="set-flag" data-tone={user.totpEnabled ? "on" : "off"}>
                        {user.totpEnabled ? "On" : "Off"}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <section id="settings-panel" className="set-panel" aria-labelledby="settings-panel-title">
            <div className="set-panel__head">
              <span className="set-panel__icon" aria-hidden="true">
                <CurrentIcon />
              </span>
              <div className="min-w-0">
                <h2 id="settings-panel-title" className="set-panel__title">{current.title}</h2>
                <p className="set-panel__sub">{current.description}</p>
              </div>
            </div>
            <div className="set-panel__body">
              {/* Swapped, not expanded: one section is mounted at a time, so no
                  height is animated and nothing below shifts. Keyed on the id so
                  changing section remounts and replays the entrance — there is no
                  AnimatePresence because an exit would leave the panel empty for
                  the length of the transition and collapse it. */}
              <motion.div
                key={active}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: EASE }}
              >
                <SectionBody id={active} user={user} />
              </motion.div>
            </div>
          </section>
        </div>
      </div>
    </MotionConfig>
  );
}

function IdentityChip({ user }: { user: SessionUser }) {
  return (
    <div className="set-id">
      <span className="set-id__mark" aria-hidden="true">
        {user.username.slice(0, 1) || "?"}
      </span>
      <div className="set-id__main">
        <p className="set-id__name">{user.username}</p>
        <p className="set-id__meta">
          <span className="set-id__role">{user.role}</span>
          <span className="truncate">{user.email ?? "No email on file"}</span>
        </p>
      </div>
    </div>
  );
}

function SectionBody({ id, user }: { id: SectionId; user: SessionUser }) {
  switch (id) {
    case "password":
      return <PasswordSection />;
    case "step-code":
      return <StepCodeSection />;
    case "2fa":
      return <TwoFactorSection enabled={!!user.totpEnabled} />;
    case "profile":
      return <ProfileSection user={user} />;
    case "appearance":
      return <AppearanceSection />;
    case "devices":
      return <SessionsSection />;
    case "about":
      return <AboutSection />;
  }
}

// ─── Profile ──────────────────────────────────────────────────────────────────

function ProfileSection({ user }: { user: SessionUser }) {
  const used = user.usedBytes ?? 0;
  const quota = user.quotaBytes ?? 0;
  const percent = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const tone = percent >= 95 ? "full" : percent >= 80 ? "warn" : "ok";

  return (
    <>
      <div className="set-group">
        <dl className="set-facts">
          <div className="set-fact">
            <dt>Username</dt>
            <dd>{user.username}</dd>
          </div>
          <div className="set-fact">
            <dt>Email</dt>
            <dd>{user.email ?? "Not set"}</dd>
          </div>
          <div className="set-fact">
            <dt>Role</dt>
            <dd className="capitalize">{user.role}</dd>
          </div>
        </dl>
      </div>
      <div className="set-group">
        <p className="set-group__title">Storage</p>
        <div className="set-meter">
          <div
            className="set-meter__track"
            role="progressbar"
            aria-label="Storage used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <div className="set-meter__fill" data-tone={tone} style={{ width: `${percent}%` }} />
          </div>
          <p className="set-meter__row">
            <span>{formatBytes(used)} used</span>
            <span>{quota > 0 ? `${formatBytes(quota)} total` : "No quota set"}</span>
          </p>
        </div>
      </div>
    </>
  );
}

// ─── Appearance ───────────────────────────────────────────────────────────────

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <>
      <div className="set-group">
        <p className="set-group__title" id="set-theme-label">Theme</p>
        {/* Buttons with aria-pressed rather than role="radio": a real radiogroup
            owes the user arrow-key traversal, and these stay plain tab stops. */}
        <div className="set-choice" role="group" aria-labelledby="set-theme-label">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className="set-choice__item"
              data-active={theme === value}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              <Icon aria-hidden="true" />
              <span className="set-choice__label">{label}</span>
            </button>
          ))}
        </div>
      </div>
      <LiteModeSetting />
    </>
  );
}

const LITE_OPTIONS: readonly { value: LitePreference; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Follow device & network" },
  { value: "on", label: "On", hint: "Always lightweight" },
  { value: "off", label: "Off", hint: "Always full effects" },
];

/**
 * Auto is the right default for almost everyone — the override exists for the
 * two cases detection cannot see: a capable phone on a metered/throttled link
 * that wants Lite anyway, and a device that trips the heuristic but is actually
 * fine (or is plugged into a fast network) and wants the full chrome back.
 */
function LiteModeSetting() {
  const preference = useLitePreference();
  const active = useLiteMode();

  return (
    <div className="set-group">
      <p className="set-group__title" id="set-lite-label">Lite mode</p>
      <p className="set-group__note">
        Drops heavy visual effects and loads smaller thumbnails to keep things
        smooth on slower devices and connections.
      </p>
      <div className="set-choice" role="group" aria-labelledby="set-lite-label">
        {LITE_OPTIONS.map(({ value, label, hint }) => (
          <button
            key={value}
            type="button"
            className="set-choice__item"
            data-active={preference === value}
            aria-pressed={preference === value}
            onClick={() => setLitePreference(value)}
          >
            <span className="set-choice__label">{label}</span>
            <span className="set-choice__hint">{hint}</span>
          </button>
        ))}
      </div>
      {preference === "auto" && (
        <p className="set-group__note">Currently {active ? "on" : "off"} for this device.</p>
      )}
    </div>
  );
}

// ─── About ────────────────────────────────────────────────────────────────────

/**
 * Read-only. `APP_VERSION` is pinned to `package.json` by a test, so what this
 * row shows is the version that was actually built and deployed.
 */
function AboutSection() {
  return (
    <dl className="set-facts">
      <div className="set-fact">
        <dt>App version</dt>
        <dd>{APP_VERSION_LABEL}</dd>
      </div>
      <div className="set-fact">
        <dt>Release</dt>
        <dd>Second Brain 2.0</dd>
      </div>
    </dl>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

/** Mirrors the real split, so the rail and the panel do not jump into place. */
function SettingsSkeleton() {
  return (
    <div className="set-page">
      <div className="set-skel set-skel--head skeleton" />
      <div className="set-body">
        <div className="set-skel set-skel--nav skeleton" />
        <div className="set-skel set-skel--panel skeleton" />
      </div>
    </div>
  );
}
