# @dool2/mcp-tools

The Dool2 tools server (MCP). The agent's built-in tools are off, so it can use **only this server's tools** ([ADR 0003](../../docs/decisions/0003-dool2-tools-only.md)).

| Tool                                                     | Tier   | Description                                                                                                                                |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`                                                 | lookup | The current date and time (Korea time) and Dool2's status                                                                                  |
| `browser_open` · `browser_navigate` · `browser_read`     | lookup | Opens a "Dool2" tab in the user's Chrome and reads the page as text. Click targets are marked like `[e12 button "검색"]` (button "Search") |
| `browser_screenshot` · `browser_scroll` · `browser_back` | lookup | See the screen as an image, scroll, go back                                                                                                |
| `browser_click` · `browser_type` · `browser_press`       | fill   | Real mouse and key input. **The daemon blocks buttons that spend money, contact someone, or cannot be undone, and hands off to a person**  |
| `browser_close`                                          | fill   | Closes a Dool2 tab that is done                                                                                                            |

The browser tools do not make decisions; they pass to the Dool2 daemon (`/api/tools/browser/<tool>`). When the daemon starts this server, it supplies the address and a **tool-only token** (`DOOL2_API`, `DOOL2_TOOL_TOKEN`), and the path of the service tool list it wrote for that run (`DOOL2_SERVICE_TOOLS`), so the server answers the agent at once instead of asking the daemon first. The risk decisions live in the daemon's `browser-tools.ts`. PC control (M4) tools will be added here too. From M3, risky actions run only after phone approval.

- `createServer()`: creates the MCP server with the tools registered.
- `@dool2/mcp-tools/server`: the stdio entry point that the agent launches.

When adding a new tool, always decide its tier (lookup / fill / pay / contact), and add `readOnlyHint` to tools that only look things up.
