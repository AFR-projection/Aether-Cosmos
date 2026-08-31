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
import { useTheme } from "@/ui/providers/theme-provider";
import { apiFetch } from "@/shared/api/client";
import { APP_NAME, APP_VERSION_LABEL } from "@/shared/lib/app-version";
import { useFormat, useT, type TranslationKey, type Translator } from "@/shared/lib/i18n";
import { LanguageSelector } from "@/ui/i18n/language-selector";
import {
  PasswordSection,
  StepCodeSection,
  TwoFactorSection,
} from "@auth/presentation/components/account-security-sections";
import { SessionsSection } from "@auth/presentation/components/sessions-section";
import { rememberCurrentSessionId } from "@/ui/hooks/use-realtime-events";
import {
  setLitePreference,
  useLiteMode,
  useLitePreference,
  type LitePreference,
} from "@/shared/lib/system/lite-mode";

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

/** `as const satisfies` keeps `id` a literal union while forcing every
    `labelKey` to be a key English actually has. */
const GROUPS = [
  { id: "security", labelKey: "settings.group.security" },
  { id: "account", labelKey: "settings.group.account" },
  { id: "system", labelKey: "settings.group.system" },
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

type GroupId = (typeof GROUPS)[number]["id"];

type Section = {
  id: SectionId;
  group: GroupId;
  titleKey: TranslationKey;
  /** About shows a product name and a build version, which are not prose. */
  descriptionKey?: TranslationKey;
  descriptionText?: string;
  icon: typeof KeyRound;
};

/**
 * Declared once at module scope, not rebuilt per render, and holding no JSX —
 * the panel is looked up by id and mounted on its own. The old page built an
 * array of seven live elements every render, so every section (including the
 * two that fetch) was mounted even while collapsed.
 *
 * The table holds translation keys rather than text so it can stay at module
 * scope: `t` is only available inside a component.
 */
const SECTIONS: readonly Section[] = [
  { id: "password", group: "security", titleKey: "settings.section.password.title", descriptionKey: "settings.section.password.description", icon: KeyRound },
  { id: "step-code", group: "security", titleKey: "settings.section.stepCode.title", descriptionKey: "settings.section.stepCode.description", icon: Hash },
  { id: "2fa", group: "security", titleKey: "settings.section.twoFactor.title", descriptionKey: "settings.section.twoFactor.description", icon: Shield },
  { id: "profile", group: "account", titleKey: "settings.section.profile.title", descriptionKey: "settings.section.profile.description", icon: UserRound },
  { id: "appearance", group: "account", titleKey: "settings.section.appearance.title", descriptionKey: "settings.section.appearance.description", icon: Palette },
  { id: "devices", group: "account", titleKey: "settings.section.devices.title", descriptionKey: "settings.section.devices.description", icon: Laptop },
  { id: "about", group: "system", titleKey: "settings.section.about.title", descriptionText: `${APP_NAME} ${APP_VERSION_LABEL}`, icon: Info },
];

function sectionDescription(section: Section, t: Translator): string {
  return section.descriptionKey ? t(section.descriptionKey) : (section.descriptionText ?? "");
}

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
  const t = useT();
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
              {t("settings.kicker")}
            </p>
            <h1>{t("settings.title")}</h1>
            <p>{t("settings.intro")}</p>
          </div>
          <IdentityChip user={user} />
        </header>

        <div className="set-body">
          <nav className="set-nav" aria-label={t("settings.navLabel")}>
            {GROUPS.map((group) => (
              <div key={group.id} className="set-nav__group">
                <p className="set-nav__label">{t(group.labelKey)}</p>
                {SECTIONS.filter((section) => section.group === group.id).map((section) => (
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
                    <span className="set-nav__text">{t(section.titleKey)}</span>
                    {section.id === "2fa" && (
                      <span className="set-flag" data-tone={user.totpEnabled ? "on" : "off"}>
                        {user.totpEnabled ? t("common.on") : t("common.off")}
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
                <h2 id="settings-panel-title" className="set-panel__title">{t(current.titleKey)}</h2>
                <p className="set-panel__sub">{sectionDescription(current, t)}</p>
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
  const t = useT();
  return (
    <div className="set-id">
      <span className="set-id__mark" aria-hidden="true">
        {user.username.slice(0, 1) || "?"}
      </span>
      <div className="set-id__main">
        <p className="set-id__name">{user.username}</p>
        <p className="set-id__meta">
          <span className="set-id__role">{user.role}</span>
          <span className="truncate">{user.email ?? t("settings.noEmail")}</span>
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
  const t = useT();
  const { formatBytes } = useFormat();
  const used = user.usedBytes ?? 0;
  const quota = user.quotaBytes ?? 0;
  const percent = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
  const tone = percent >= 95 ? "full" : percent >= 80 ? "warn" : "ok";

  return (
    <>
      <div className="set-group">
        <dl className="set-facts">
          <div className="set-fact">
            <dt>{t("settings.profile.username")}</dt>
            <dd>{user.username}</dd>
          </div>
          <div className="set-fact">
            <dt>{t("settings.profile.email")}</dt>
            <dd>{user.email ?? t("settings.notSet")}</dd>
          </div>
          <div className="set-fact">
            <dt>{t("settings.profile.role")}</dt>
            <dd className="capitalize">{user.role}</dd>
          </div>
        </dl>
      </div>
      <div className="set-group">
        <p className="set-group__title">{t("settings.profile.storage")}</p>
        <div className="set-meter">
          <div
            className="set-meter__track"
            role="progressbar"
            aria-label={t("settings.profile.storageUsed")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <div className="set-meter__fill" data-tone={tone} style={{ width: `${percent}%` }} />
          </div>
          <p className="set-meter__row">
            <span>{t("settings.profile.used", { size: formatBytes(used) })}</span>
            <span>
              {quota > 0
                ? t("settings.profile.total", { size: formatBytes(quota) })
                : t("settings.profile.noQuota")}
            </span>
          </p>
        </div>
      </div>
    </>
  );
}

// ─── Appearance ───────────────────────────────────────────────────────────────

const THEME_OPTIONS = [
  { value: "light", labelKey: "settings.appearance.light", icon: Sun },
  { value: "dark", labelKey: "settings.appearance.dark", icon: Moon },
  { value: "system", labelKey: "settings.appearance.system", icon: Monitor },
] as const satisfies readonly { value: string; labelKey: TranslationKey; icon: typeof Sun }[];

function AppearanceSection() {
  const t = useT();
  const { theme, setTheme } = useTheme();

  return (
    <>
      <div className="set-group">
        <p className="set-group__title" id="set-theme-label">{t("settings.appearance.theme")}</p>
        {/* Buttons with aria-pressed rather than role="radio": a real radiogroup
            owes the user arrow-key traversal, and these stay plain tab stops. */}
        <div className="set-choice" role="group" aria-labelledby="set-theme-label">
          {THEME_OPTIONS.map(({ value, labelKey, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className="set-choice__item"
              data-active={theme === value}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              <Icon aria-hidden="true" />
              <span className="set-choice__label">{t(labelKey)}</span>
            </button>
          ))}
        </div>
      </div>
      <LanguageSelector />
      <LiteModeSetting />
    </>
  );
}

const LITE_OPTIONS = [
  { value: "auto", labelKey: "settings.lite.auto", hintKey: "settings.lite.autoHint" },
  { value: "on", labelKey: "common.on", hintKey: "settings.lite.onHint" },
  { value: "off", labelKey: "common.off", hintKey: "settings.lite.offHint" },
] as const satisfies readonly {
  value: LitePreference;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}[];

/**
 * Auto is the right default for almost everyone — the override exists for the
 * two cases detection cannot see: a capable phone on a metered/throttled link
 * that wants Lite anyway, and a device that trips the heuristic but is actually
 * fine (or is plugged into a fast network) and wants the full chrome back.
 */
function LiteModeSetting() {
  const t = useT();
  const preference = useLitePreference();
  const active = useLiteMode();

  return (
    <div className="set-group">
      <p className="set-group__title" id="set-lite-label">{t("settings.lite.title")}</p>
      <p className="set-group__note">{t("settings.lite.note")}</p>
      <div className="set-choice" role="group" aria-labelledby="set-lite-label">
        {LITE_OPTIONS.map(({ value, labelKey, hintKey }) => (
          <button
            key={value}
            type="button"
            className="set-choice__item"
            data-active={preference === value}
            aria-pressed={preference === value}
            onClick={() => setLitePreference(value)}
          >
            <span className="set-choice__label">{t(labelKey)}</span>
            <span className="set-choice__hint">{t(hintKey)}</span>
          </button>
        ))}
      </div>
      {preference === "auto" && (
        <p className="set-group__note">
          {active ? t("settings.lite.currentlyOn") : t("settings.lite.currentlyOff")}
        </p>
      )}
    </div>
  );
}

// ─── About ────────────────────────────────────────────────────────────────────

/** The release codename is a proper noun, so it is not a translation key. */
const RELEASE_NAME = "Second Brain 2.0";

/**
 * Read-only. `APP_VERSION` is pinned to `package.json` by a test, so what this
 * row shows is the version that was actually built and deployed.
 */
function AboutSection() {
  const t = useT();
  return (
    <dl className="set-facts">
      <div className="set-fact">
        <dt>{t("settings.about.appVersion")}</dt>
        <dd>{APP_VERSION_LABEL}</dd>
      </div>
      <div className="set-fact">
        <dt>{t("settings.about.release")}</dt>
        <dd>{RELEASE_NAME}</dd>
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
