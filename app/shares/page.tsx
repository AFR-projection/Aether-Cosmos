import { SharingHub } from "@shares/presentation/sharing-hub";
import { resolveSharingView } from "@shares/domain/sharing-view";

export default async function SharesPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const params = await searchParams;
  return <SharingHub initialView={resolveSharingView(params.view)} />;
}
