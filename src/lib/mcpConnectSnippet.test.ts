import { describe, expect, it } from 'vitest'
import en from '../locales/en/ai.json'
import vi from '../locales/vi/ai.json'
import { buildClaudeDesktopMcpConfig } from './mcpConnectSnippet'

describe('buildClaudeDesktopMcpConfig', () => {
  it('points a desktop MCP client at the resolved binary with --mcp-stdio', () => {
    const binaryPath = '/Users/thi/git/memlore/src-tauri/target/debug/memlore'
    const snippet = buildClaudeDesktopMcpConfig(binaryPath)
    const parsed = JSON.parse(snippet) as {
      mcpServers: { memlore: { command: string; args: string[] } }
    }

    expect(parsed.mcpServers.memlore.command).toBe(binaryPath)
    expect(parsed.mcpServers.memlore.args).toEqual(['--mcp-stdio'])
    expect(snippet).not.toContain('/Applications')
  })

  it('does not name a specific client or config-file path in Settings copy', () => {
    for (const bundle of [en, vi]) {
      expect(bundle.mcp.config_snippet).not.toMatch(/claude/i)
      expect(bundle.mcp.config_snippet_hint).not.toMatch(/claude/i)
      expect(bundle.mcp.config_snippet_hint).not.toMatch(/\.json/i)
    }
  })
})
