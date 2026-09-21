/**
 * Stdio MCP client fragment. Any desktop client that accepts a
 * `mcpServers` map can paste this — not Claude-specific.
 * `binaryPath` must come from `mcp_status` (`std::env::current_exe()`),
 * never a hardcoded `/Applications` path.
 */
export function buildClaudeDesktopMcpConfig(binaryPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        memlore: {
          command: binaryPath,
          args: ['--mcp-stdio'],
        },
      },
    },
    null,
    2,
  )
}
