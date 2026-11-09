import type { PluginMcpServers } from "@t3tools/contracts";

export function sdkMcpServers(servers: PluginMcpServers = {}) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.transport === "stdio"
        ? {
            type: "stdio" as const,
            command: server.command,
            args: [...server.args],
            env: { ...server.environment },
          }
        : { type: server.transport, url: server.url, headers: { ...server.headers } },
    ]),
  );
}

export function codexMcpServers(servers: PluginMcpServers = {}) {
  if (Object.values(servers).some((server) => server.transport === "sse"))
    throw new Error("Codex requires stdio or Streamable HTTP MCP servers");
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      `mcp_servers.${name}`,
      server.transport === "stdio"
        ? { command: server.command, args: [...server.args], env: { ...server.environment } }
        : { url: server.url, http_headers: { ...server.headers } },
    ]),
  );
}

export function acpMcpServers(servers: PluginMcpServers = {}) {
  return Object.entries(servers).map(([name, server]) =>
    server.transport === "stdio"
      ? {
          name,
          command: server.command,
          args: [...server.args],
          env: Object.entries(server.environment).map(([name, value]) => ({ name, value })),
        }
      : {
          name,
          type: server.transport,
          url: server.url,
          headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
        },
  );
}

export function openCodeMcpServers(servers: PluginMcpServers = {}) {
  return Object.entries(servers).map(([name, server]) => ({
    name,
    config:
      server.transport === "stdio"
        ? {
            type: "local" as const,
            command: [server.command, ...server.args],
            environment: { ...server.environment },
            enabled: true,
          }
        : {
            type: "remote" as const,
            url: server.url,
            headers: { ...server.headers },
            oauth: false as const,
            enabled: true,
          },
  }));
}

export function museMcpServers(servers: PluginMcpServers = {}) {
  if (Object.values(servers).some((server) => server.transport === "sse"))
    throw new Error("Muse requires stdio or Streamable HTTP MCP servers");
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.transport === "stdio"
        ? {
            transport: "stdio",
            mode: "required",
            command: server.command,
            args: [...server.args],
            env: { ...server.environment },
          }
        : {
            transport: "streamableHttp",
            mode: "required",
            url: server.url,
            headers: { ...server.headers },
          },
    ]),
  );
}
