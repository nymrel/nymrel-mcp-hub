# Remote access research and Nymrel decisions (2026-09-22)

This is a design comparison based on public product documentation. It does not assume access to a competitor's private implementation.

| Product | Published capability relevant to cloud agents | Nymrel decision |
| --- | --- | --- |
| [Remote Desktop Commander](https://github.com/desktop-commander/remote-desktop-commander) | Hosted remote MCP with a paired local agent and file, search, and process operations. | Keep the outbound native agent and durable broker. Pair devices to a tenant and expose a separate narrow ChatGPT read-only resource. |
| [OpenClaw nodes](https://docs.openclaw.ai/nodes) | Paired devices expose capabilities to an agent through a gateway. | Keep device identity, capability boundaries, and per-call audit visible; do not infer authority from device presence alone. |
| [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh) | Identity-aware private access to a device. | Consider as an operator administration path, not as a replacement for scoped MCP tools and tenant checks. |
| [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) | Outbound tunnel from a private service to Cloudflare. | Consider only as a transport option. Nymrel still verifies OAuth audience, subject-to-tenant mapping, and tool scope at the application boundary. |
| [Apache Guacamole](https://guacamole.apache.org/) | Browser gateway for interactive RDP, VNC and SSH sessions. | Keep interactive desktop access separate from bounded, auditable agent tools. |
| [RustDesk](https://rustdesk.com/docs/en/self-host/) and [Chrome Remote Desktop](https://support.google.com/chrome/answer/1649523?hl=en-u) | Interactive remote control, with a self-hosted server option for RustDesk. | Evaluate for human support needs; neither public contract replaces Nymrel's scoped file and process API. |

## Implemented in this branch

- The full remote broker and native-agent lane includes the process-output polling fix from PR #22.
- The ChatGPT read-only lane includes the bounded OAuth acceptance and exact-audience tests from PR #34. Its catalog contains six inspection tools; file and process writes are outside that resource.
- Railway watches are anchored to the repository-root `remote-control/` path, with Git-backed tests that run on Windows and Unix.

## Activation gates

The endpoint is a local integration candidate until an operator supplies a compatible OAuth authorization server and client, restricts JalenPC's allowed directories, deploys the reviewed revision, and proves a real ChatGPT connection with token refresh. See [ChatGPT Pro read-only](CHATGPT_PRO_READONLY.md) and [Railway deployment](RAILWAY_DEPLOYMENT.md). A private network or tunnel by itself does not satisfy those identity and file-boundary gates.
