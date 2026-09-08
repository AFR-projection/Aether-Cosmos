export const SHARING_RECEIVED_HREF = "/shares?view=received";
export const SHARING_LINKS_HREF = "/shares?view=links";

export type SharingView = "received" | "links";

export function resolveSharingView(
  value: string | readonly string[] | null | undefined
): SharingView {
  return value === "links" ? "links" : "received";
}
