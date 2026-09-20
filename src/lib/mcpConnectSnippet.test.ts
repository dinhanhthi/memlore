import { describe, expect, it } from 'vitest'
import { buildClaudeDesktopMcpConfig } from './mcpConnectSnippet'

describe('buildClaudeDesktopMcpConfig', () => {
  it('points Claude Desktop at the resolved binary with --mcp-stdio', () => {
    const binaryPath = '/Users/thi/git/memlore/src-tauri/target/debug/memlore'
    const snippet = buildClaudeDesktopMcpConfig(binaryPath)
    const parsed = JSON.parse(snippet) as {
      mcpServers: { memlore: { command: string; args: string[] } }
    }

    expect(parsed.mcpServers.memlore.command).toBe(binaryPath)
    expect(parsed.mcpServers.memlore.args).toEqual(['--mcp-stdio'])
    expect(snippet).not.toContain('/Applications')
  })
})
