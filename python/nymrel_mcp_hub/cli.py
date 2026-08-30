"""
CLI binary entrypoint for Python engine
"""

import sys
from .server import MCPServer
from .tools import ALL_TOOLS

def main():
    args = sys.argv[1:]
    if "--help" in args or "-h" in args:
        print("""
nymrel-mcp (Python Engine) v1.0.0
Unified Model Context Protocol (MCP) Server for Nymrel Tools

Usage:
  nymrel-mcp [options]

Options:
  --stdio            Start stdio MCP server (default)
  --list-tools       List all 14 registered MCP tools
  --version, -v      Print version
""")
        sys.exit(0)

    if "--version" in args or "-v" in args:
        print("nymrel-mcp-hub py v1.0.0")
        sys.exit(0)

    if "--list-tools" in args:
        print("=== 14 Registered Nymrel Tools ===")
        for i, t in enumerate(ALL_TOOLS, 1):
            print(f"{i}. [{t['name']}] - {t['description']}")
        sys.exit(0)

    server = MCPServer()
    server.start_stdio()

if __name__ == "__main__":
    main()
