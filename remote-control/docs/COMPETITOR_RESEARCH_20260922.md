# Remote access research and Nymrel decisions (2026-09-22)

This is a design comparison based on public product documentation. It does not assume access to a competitor's private implementation.

| Product | Published capability relevant to cloud agents | Nymrel decision |
| --- | --- | --- |
| [Remote Desktop Commander](https://github.com/desktop-commander/remote-desktop-commander) | Hosted remote MCP with a paired local agent and file, search, and process operations. | Keep the outbound native agent and durable broker. Pair devices to a tenant and expose a separate narrow ChatGPT read-only resource. |
| [OpenClaw nodes](https://docs.openclaw.ai/nodes) | Paired devices expose capabilities to an agent through a gateway. | Keep device identity, capability boundaries, and per-call audit visible; do not infer authority from device presence alone. |
| [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh) | Identity-aware private access to a device. | Consider as an operator administration path, not as a replacement for scoped MCP tools and tenant checks. |
| [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) | Outbound tunnel from a private service to Cloudflare. | Consider only as a transport option. Nymrel still verifies OAuth audience, subject-to-tenant mapping, and tool scope at the application boundary. |
| [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) | Identity and device rules can guard an application reached through Cloudflare. | A front-door policy can supplement Nymrel's checks; verify that ChatGPT's OAuth discovery and callback still work through it before choosing this route. |
| [VS Code Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels) | A signed-in VS Code client can reach a local development machine through a tunnel and run its editor/terminal extensions there. | Useful for developer sessions; it does not supply the seven bounded MCP tools to an ordinary ChatGPT conversation. |
| [GitHub Codespaces](https://docs.github.com/en/codespaces/about-codespaces/what-are-codespaces) | A repository-backed Linux development environment runs in GitHub's cloud. | Use for isolated repository work where appropriate. It does not grant access to JalenPC's current local files or Windows applications. |
| [Apache Guacamole](https://guacamole.apache.org/) | Browser gateway for interactive RDP, VNC and SSH sessions. | Keep interactive desktop access separate from bounded, auditable agent tools. |
| [RustDesk](https://rustdesk.com/docs/en/self-host/) and [Chrome Remote Desktop](https://support.google.com/chrome/answer/1649523?hl=en-u) | Interactive remote control, with a self-hosted server option for RustDesk. | Evaluate for human support needs; neither public contract replaces Nymrel's scoped file and process API. |

## Implemented in this branch

- The full remote broker and native-agent lane includes the process-output polling fix from PR #22.
- The ChatGPT read-only lane includes the bounded OAuth acceptance and exact-audience tests from PR #34. Its catalog contains seven inspection tools, including retrieval of a pending read result; file and process writes are outside that resource.
- Railway watches are anchored to the repository-root `remote-control/` path, with Git-backed tests that run on Windows and Unix.

## Activation gates

The read-only endpoint is deployed and the separate `ChatGPTStudio` Windows device is paired in its own tenant with a reviewed four-file root. Regular ChatGPT access is still closed: the free Auth0 API has no configured ChatGPT client, and production Remote advertises no authorization server. The exact staged callback and remaining token, subject-map, refresh, and ChatGPT read tests are in [OAuth provider cutover](OAUTH_PROVIDER_CUTOVER_20260922.md). The original whole-profile JalenPC device remains outside the ChatGPTStudio tenant. A private network or tunnel by itself does not satisfy the identity and file-boundary gates.
