import type { TranslationKey } from "@/shared/lib/i18n";

const PAGE_TITLE_KEYS: Record<string, TranslationKey> = {
  "/dashboard": "nav.dashboard",
  "/files": "nav.files",
  "/recycle-bin": "nav.recycleBin",
  "/backup": "nav.backup",
};

function pathFromHref(href: string): string {
  return href.split("?", 1)[0] ?? href;
}

export function isSharingPath(pathname: string): boolean {
  return pathname === "/shares" || pathname.startsWith("/shared-with-me/");
}

export function isNavigationPathActive(pathname: string, href: string): boolean {
  if (pathFromHref(href) === "/shares") return isSharingPath(pathname);
  const hrefPath = pathFromHref(href);
  return pathname === hrefPath || pathname.startsWith(`${hrefPath}/`);
}

/** null means the route uses the product name instead of a localized title. */
export function getShellTitleKey(pathname: string): TranslationKey | null {
  if (pathname.startsWith("/admin")) return "nav.admin";
  if (isSharingPath(pathname)) return "nav.sharing";
  return PAGE_TITLE_KEYS[pathname] ?? null;
}
