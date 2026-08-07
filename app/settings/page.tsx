"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { KeyRound, User, Monitor, Shield, Hash } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useTheme } from "@/components/theme-provider";
import { apiFetch } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import {
  PasswordSection as SharedPasswordSection,
  TwoFactorSection as SharedTwoFactorSection,
  StepCodeSection,
} from "@/components/account/account-security-sections";
import { SessionsSection } from "@/components/settings/sessions-section";
import { rememberCurrentSessionId } from "@/hooks/use-realtime-events";
import { setLitePreference, useLiteMode, useLitePreference } from "@/lib/system/lite-mode";
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

export default function SettingsPage() {
  const { data: sessionData, isLoading: sessionLoading } = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const res = await apiFetch<SessionUser>("/api/auth/login");
      if (!res.success || !res.data) throw new Error(res.error ?? "Not authenticated");
      rememberCurrentSessionId(res.data.sessionId);
      return res.data;
    },
  });

  const user = sessionData;

  if (sessionLoading) return <SettingsSkeleton />;
  if (!user) return null;

  return <SettingsContent user={user} />;
}

function SettingsContent({ user }: { user: SessionUser }) {
  const [openSection, setOpenSection] = useState<string | null>("password");

  const sections = [
    {
      id: "password",
      title: "Password",
      description: "Change your account password",
      icon: KeyRound,
      gradient: "from-amber-500 to-orange-500",
      component: <PasswordSection />,
    },
    {
      id: "step-code",
      title: "2-Step Code",
      description: "Numpad code entered after your password",
      icon: Hash,
      gradient: "from-cyan-500 to-blue-500",
      component: <StepCodeSection />,
    },
    {
      id: "2fa",
      title: "Two-factor authentication",
      description: "Authenticator app (TOTP) + recovery codes",
      icon: Shield,
      gradient: "from-rose-500 to-pink-500",
      component: <TwoFactorSection enabled={!!user.totpEnabled} />,
    },
    {
      id: "profile",
      title: "Profile",
      description: "Your account information",
      icon: User,
      gradient: "from-blue-500 to-cyan-500",
      component: <ProfileSection user={user} />,
    },
    {
      id: "appearance",
      title: "Appearance",
      description: "Theme preferences",
      icon: Monitor,
      gradient: "from-purple-500 to-violet-500",
      component: <AppearanceSection />,
    },
    {
      id: "sessions",
      title: "Sessions & devices",
      description: "See where you're signed in and revoke access",
      icon: Monitor,
      gradient: "from-emerald-500 to-teal-500",
      component: <SessionsSection />,
    },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-bold sm:text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account settings and preferences
        </p>
      </div>

      <div className="space-y-3">
        {sections.map((section) => {
          const isOpen = openSection === section.id;
          const Icon = section.icon;
          return (
            <Card
              key={section.id}
              className={cn(
                "overflow-hidden transition-all duration-200",
                isOpen && "shadow-lg"
              )}
            >
              <button
                onClick={() => setOpenSection(isOpen ? null : section.id)}
                className="flex w-full items-center gap-3 p-4 text-left sm:p-5"
                aria-expanded={isOpen}
              >
                <div className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm",
                  section.gradient
                )}>
                  <Icon className="h-5 w-5 text-white" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{section.title}</p>
                  <p className="text-xs text-muted-foreground/70">{section.description}</p>
                </div>
                <motion.div
                  animate={{ rotate: isOpen ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                  className="text-muted-foreground/50"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </motion.div>
              </button>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                >
                  <div className="border-t border-border/50 px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
                    {section.component}
                  </div>
                </motion.div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─── Password Section ─────────────────────────────────────────────────────────

function PasswordSection() {
  return <SharedPasswordSection />;
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  return <SharedTwoFactorSection enabled={enabled} />;
}

// ─── Profile Section ──────────────────────────────────────────────────────────

function ProfileSection({ user }: { user: SessionUser }) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-surface-hover/50 p-4">
        <label className="text-xs font-medium text-muted-foreground/70">Username</label>
        <p className="mt-0.5 text-sm font-medium">{user.username}</p>
      </div>
      <div className="rounded-lg bg-surface-hover/50 p-4">
        <label className="text-xs font-medium text-muted-foreground/70">Email</label>
        <p className="mt-0.5 text-sm font-medium">{user.email ?? "Not set"}</p>
      </div>
      <div className="rounded-lg bg-surface-hover/50 p-4">
        <label className="text-xs font-medium text-muted-foreground/70">Role</label>
        <p className="mt-0.5 text-sm font-medium capitalize">{user.role}</p>
      </div>
    </div>
  );
}

// ─── Appearance Section ───────────────────────────────────────────────────────

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  const options = [
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
    { value: "system", label: "System", icon: Monitor },
  ] as const;

  return (
    <div className="space-y-3">
      <label className="text-sm font-medium">Theme</label>
      <div className="grid grid-cols-3 gap-2">
        {options.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            onClick={() => setTheme(value)}
            className={cn(
              "flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all",
              theme === value
                ? "border-accent bg-accent/10"
                : "border-border/50 hover:border-border/80 bg-transparent"
            )}
          >
            <Icon className={cn("h-5 w-5", theme === value ? "text-accent" : "text-muted-foreground")} />
            <span className={cn("text-xs font-medium", theme === value ? "text-accent" : "text-muted-foreground")}>
              {label}
            </span>
          </button>
        ))}
      </div>

      <LiteModeSetting />
    </div>
  );
}

// ─── Lite mode ────────────────────────────────────────────────────────────────

/**
 * Auto is the right default for almost everyone — the override exists for the
 * two cases detection cannot see: a capable phone on a metered/throttled link
 * that wants Lite anyway, and a device that trips the heuristic but is actually
 * fine (or is plugged into a fast network) and wants the full chrome back.
 */
function LiteModeSetting() {
  const preference = useLitePreference();
  const active = useLiteMode();

  const options = [
    { value: "auto", label: "Auto", hint: "Follow device & network" },
    { value: "on", label: "On", hint: "Always lightweight" },
    { value: "off", label: "Off", hint: "Always full effects" },
  ] as const;

  return (
    <div className="space-y-3 border-t border-border/50 pt-4">
      <div>
        <label className="text-sm font-medium">Lite mode</label>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Drops heavy visual effects and loads smaller thumbnails to keep things
          smooth on slower devices and connections.
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {options.map(({ value, label, hint }) => (
          <button
            key={value}
            onClick={() => setLitePreference(value)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-xl border-2 px-2 py-3 text-center transition-all",
              preference === value
                ? "border-accent bg-accent/10"
                : "border-border/50 bg-transparent hover:border-border/80"
            )}
          >
            <span
              className={cn(
                "text-xs font-medium",
                preference === value ? "text-accent" : "text-muted-foreground"
              )}
            >
              {label}
            </span>
            <span className="text-[10px] leading-tight text-muted-foreground/70">{hint}</span>
          </button>
        ))}
      </div>
      {preference === "auto" && (
        <p className="text-xs text-muted-foreground/70">
          Currently {active ? "on" : "off"} for this device.
        </p>
      )}
    </div>
  );
}

function SunIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  );
}

function MoonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SettingsSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
      <div className="h-8 w-32 animate-pulse rounded-lg bg-surface-hover" />
      <div className="h-4 w-64 animate-pulse rounded-lg bg-surface-hover" />
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-2xl bg-surface-hover" />
        ))}
      </div>
    </div>
  );
}