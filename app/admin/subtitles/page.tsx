"use client";

import { Captions, Users } from "lucide-react";
import Link from "next/link";
import { AdminHeader } from "@admin/presentation/components/admin-ui";
import { Button } from "@/ui/primitives/button";
import { useT } from "@/shared/lib/i18n";
import { SubtitleSettingsCard } from "@files/presentation/components/subtitles/subtitle-settings-card";

/**
 * Where the subtitle providers are configured.
 *
 * Its own page rather than a section of /admin/settings, following /admin/email: that page writes
 * `system_settings` fields, and these two secrets live in their own table with their own encryption
 * and their own Test endpoint. Mixing them into a form that saves a flat settings object would mean
 * one Save button with two very different failure modes behind it.
 *
 * The per-user allowance is only pointed at, not edited here. It is a property of an account and
 * belongs on the account, which is where a master already goes to change a quota.
 */
export default function AdminSubtitlesPage() {
  const t = useT();

  return (
    <div className="space-y-5">
      <AdminHeader
        icon={Captions}
        kicker={t("admin.subtitles.kicker")}
        title={t("admin.subtitles.title")}
        lede={t("admin.subtitles.lede")}
      />

      <SubtitleSettingsCard />

      <div className="adm-panel">
        <div className="adm-panel__head">
          <span className="adm-panel__badge">
            <Users aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="adm-panel__title">{t("admin.subtitles.allowance.heading")}</h2>
            <p className="adm-panel__sub">{t("admin.subtitles.allowance.lede")}</p>
          </div>
          <div className="adm-panel__tools">
            <Button asChild variant="secondary" size="sm">
              <Link href="/admin/users">{t("admin.subtitles.allowance.openUsers")}</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
