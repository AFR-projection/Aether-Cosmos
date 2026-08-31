import type { Metadata } from "next";
import { ActivityCenterLayout } from "@shell/layouts/activity-center-layout";
import { APP_NAME } from "@/shared/lib/app-version";

export const metadata: Metadata = {
  title: `File Activity Center | ${APP_NAME}`,
  description: "Monitor file uploads, downloads, and activity in real time.",
};

export default function FileActivityLayout({ children }: { children: React.ReactNode }) {
  return <ActivityCenterLayout>{children}</ActivityCenterLayout>;
}
