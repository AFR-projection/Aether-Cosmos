import "@/shared/lib/env/load-env";
import { workDeliveryHandlers } from "./handlers";
import { startSubtitleWorker } from "./runtime";
import { handleSubtitleWork } from "./handler-entry";

void startSubtitleWorker({ role: "translate", handlers: workDeliveryHandlers(handleSubtitleWork) }).catch((error) => {
  console.error(`Subtitle translation worker failed to start: ${(error as Error).message}`);
  process.exitCode = 1;
});
