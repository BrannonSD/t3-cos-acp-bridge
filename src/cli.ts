#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import {
  agentProtocolRouter,
  ndJsonStream,
} from "@agentclientprotocol/sdk/experimental/v2";
import { apps } from "./adapter.js";
import { serve, BrokerClient } from "./broker.js";
if (process.argv.includes("--existing-install"))
  process.env.COS_ACP_MODE = "existing-install";
if (process.argv.includes("--broker")) await serve();
else if (process.argv.includes("--diagnose")) {
  try {
    const health = await new BrokerClient().call<{
      actions: { enabled: boolean };
      integration?: {
        appVersion: string;
        tier: string;
        permissions: string;
        workspace: string;
        models: boolean;
        attachments: boolean;
      };
    }>("health");
    process.stdout.write(
      `Chat on Steroids connected. Actions ${health.actions.enabled ? "enabled" : "disabled"}.\n${health.integration ? `CoS ${health.integration.appVersion}; compatibility: ${health.integration.tier}; permissions: ${health.integration.permissions}; workspace: ${health.integration.workspace}; models: ${health.integration.models ? "account catalog" : "current CoS selection only"}; attachments: ${health.integration.attachments ? "available" : "unavailable"}.\n` : ""}`,
    );
  } catch (error) {
    process.stderr.write(
      error instanceof Error
        ? `${error.message}\n`
        : "Chat on Steroids unavailable. Check the app and local control settings.\n",
    );
    process.exitCode = 1;
  }
} else {
  const { app1, app2 } = apps();
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    { maxMessageBytes: 24 * 1024 * 1024 },
  );
  const connection = agentProtocolRouter()
    .withV1(app1)
    .withV2(app2)
    .connect(stream);
  await connection.closed;
}
