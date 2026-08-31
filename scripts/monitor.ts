#!/usr/bin/env node
/**
 * Health monitoring CLI tool
 *
 * Usage:
 *   node scripts/monitor.js                    # one-shot check
 *   node scripts/monitor.js --loop             # continuous monitoring
 *   node scripts/monitor.js --webhook URL      # send to webhook
 *   node scripts/monitor.js --file PATH        # log to file
 */

import "@/shared/lib/env/load-env";
import {
  monitorHealth,
  runHealthChecks,
  ConsoleAlertChannel,
  WebhookAlertChannel,
  FileAlertChannel,
  type AlertChannel,
} from "@/shared/lib/monitoring/health-monitor";

async function main() {
  const args = process.argv.slice(2);

  const loop = args.includes("--loop");
  const webhookIndex = args.indexOf("--webhook");
  const fileIndex = args.indexOf("--file");
  const intervalIndex = args.indexOf("--interval");

  const channels: AlertChannel[] = [new ConsoleAlertChannel()];

  if (webhookIndex !== -1 && args[webhookIndex + 1]) {
    channels.push(new WebhookAlertChannel(args[webhookIndex + 1]));
  }

  if (fileIndex !== -1 && args[fileIndex + 1]) {
    channels.push(new FileAlertChannel(args[fileIndex + 1]));
  }

  const interval = intervalIndex !== -1 && args[intervalIndex + 1]
    ? parseInt(args[intervalIndex + 1], 10)
    : 300;

  if (loop) {
    await monitorHealth({
      interval,
      alertChannels: channels,
      alertOnDegraded: true,
      alertOnHealthy: false,
    });
  } else {
    // One-shot check
    const report = await runHealthChecks();

    for (const channel of channels) {
      await channel.send(report);
    }

    process.exit(report.overall === "critical" ? 1 : 0);
  }
}

main().catch((error) => {
  console.error("Monitor failed:", error);
  process.exit(1);
});
