import type { Metadata } from "next";
import { ActivityCenterLayout } from "@/components/layout/activity-center-layout";

export const metadata: Metadata = {
  title: "File Activity Center | Storage ByAFR",
  description: "Monitor file uploads, downloads, and activity in real time.",
};

export default function FileActivityLayout({ children }: { children: React.ReactNode }) {
  return <ActivityCenterLayout>{children}</ActivityCenterLayout>;
}
