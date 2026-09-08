import { redirect } from "next/navigation";
import { SHARING_RECEIVED_HREF } from "@shares/domain/sharing-view";

export default function InvitationsPage() {
  redirect(SHARING_RECEIVED_HREF);
}
