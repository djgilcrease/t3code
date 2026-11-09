import { expect, it } from "vite-plus/test";
import {
  acpMcpServers,
  codexMcpServers,
  museMcpServers,
  openCodeMcpServers,
} from "./mcpServers.ts";

it("translates HTTP credentials into each native protocol without shell interpolation", () => {
  const servers = {
    "example-database": {
      transport: "http" as const,
      url: "https://database.invalid/mcp",
      headers: { "X-Key": "private" },
    },
  };
  expect(codexMcpServers(servers)).toEqual({
    "mcp_servers.example-database": {
      url: "https://database.invalid/mcp",
      http_headers: { "X-Key": "private" },
    },
  });
  expect(acpMcpServers(servers)).toEqual([
    {
      name: "example-database",
      type: "http",
      url: "https://database.invalid/mcp",
      headers: [{ name: "X-Key", value: "private" }],
    },
  ]);
  expect(openCodeMcpServers(servers)).toEqual([
    {
      name: "example-database",
      config: {
        type: "remote",
        url: "https://database.invalid/mcp",
        headers: { "X-Key": "private" },
        oauth: false,
        enabled: true,
      },
    },
  ]);
  expect(museMcpServers(servers)).toEqual({
    "example-database": {
      transport: "streamableHttp",
      mode: "required",
      url: "https://database.invalid/mcp",
      headers: { "X-Key": "private" },
    },
  });
  const legacy = {
    "example-database": { ...servers["example-database"], transport: "sse" as const },
  };
  expect(() => codexMcpServers(legacy)).toThrow("stdio or Streamable HTTP");
  expect(() => museMcpServers(legacy)).toThrow("stdio or Streamable HTTP");
});
