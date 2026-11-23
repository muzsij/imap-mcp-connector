# IMAP MCP Connector

Use your own mailbox from **Claude** or **ChatGPT**. This is a small self-hosted server: people sign in with their email address and (app) password, choose what the AI may do, and paste one connector URL into their AI app.

- Works with any IMAP mailbox that accepts a password or app password: Gmail, iCloud, Yahoo, Fastmail, Zoho, most hosting providers and self-run servers.
- One deployment serves many users, for example a company or a family.
- Per-user permission levels: **Read only**, **Read and draft** (default), **Full access** (send and delete-to-Trash).
- Remote MCP server with OAuth 2.1 (dynamic client registration, PKCE), so it works as a custom connector in Claude and ChatGPT.

> **Not supported yet:** Outlook.com and Microsoft 365, which no longer allow password sign-in over IMAP.

This is a fork of [MinKyawNyunt/imap-mcp-connector](https://github.com/MinKyawNyunt/imap-mcp-connector); see [Differences from the original project](#differences-from-the-original-project).

## Quickstart (Docker Compose, ~5 minutes)

1. Point a DNS name (e.g. `mail.example.com`) at your server, with ports 80 and 443 open.
2. Clone this repository and create your config:
   ```bash
   cp .env.example .env
   # fill in DOMAIN, PUBLIC_URL, ENCRYPTION_KEY (openssl rand -base64 32),
   # SESSION_SECRET (openssl rand -hex 32), ALLOWED_EMAIL_DOMAINS or ALLOWED_IMAP_HOSTS
   ```
3. Start it:
   ```bash
   docker compose up -d
   ```
4. Open `https://mail.example.com`, sign in with your email and app password, and follow the connect instructions shown on the settings page.

Caddy obtains HTTPS certificates automatically.

## Connect to Claude

Settings → Connectors → **Add custom connector** → paste the connector URL from the settings page (`https://<your-domain>/mcp/<your-email>`; plain `https://<your-domain>/mcp` also works) → **Connect**. Sign in and approve access when prompted.

Tested on claude.ai and in the Claude Desktop app.

## Connect to ChatGPT

Settings → Connectors (turn on developer mode if your plan requires it) → **Create** → paste the connector URL from the settings page → authentication **OAuth**. Sign in and approve access when prompted.

To connect more than one mailbox, see [Several mailboxes](#several-mailboxes).

## Several mailboxes

AI clients refuse to add the same URL twice, so add one connector per mailbox with the address after `/mcp`:

- `https://<your-domain>/mcp/alice@example.com`
- `https://<your-domain>/mcp/bob@example.com`

Each connector signs in on its own. When the part after `/mcp/` is an email address, the sign-in form is pre-filled with it and the approval page only accepts that mailbox, so a browser still signed in to another account can't attach the wrong one ("Sign in as …" switches accounts). Any other label (letters, digits, `.`, `_`, `-`, `+`, `@`, up to 128 characters) such as `/mcp/work` also works, but is not checked against the account.

## App passwords

Most big providers refuse your normal password over IMAP once two-factor sign-in is on. Create an app password and use it to sign in:

- Gmail: https://myaccount.google.com/apppasswords
- iCloud: https://support.apple.com/en-us/102654
- Yahoo: https://help.yahoo.com/kb/SLN15241.html
- Fastmail and Zoho: search their help for "app password".

Lost it? Create a new one and sign in again. The stored password is replaced.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `PUBLIC_URL` | yes | External origin, `https://` only (no path). |
| `ENCRYPTION_KEY` | yes | 32 random bytes, base64. Encrypts stored mail passwords. **Back it up**: if it is lost, users must sign in again. |
| `SESSION_SECRET` | yes | ≥ 32 characters, signs session cookies. |
| `ALLOWED_EMAIL_DOMAINS` | at least one of these | Comma-separated email domains allowed to sign in. |
| `ALLOWED_IMAP_HOSTS` | at least one of these | Comma-separated IMAP hosts allowed; `*` allows any public server that auto-discovery finds. Hand-entered servers must be listed by name. |
| `ALLOWED_SMTP_HOSTS` | no (unrestricted) | Comma-separated SMTP hosts that may receive a user's SMTP password; `*` allows any public server. Recommended whenever `ALLOWED_IMAP_HOSTS` is set. |
| `ALLOW_PRIVATE_HOSTS` | no (`false`) | Allow mail servers on private networks and unencrypted connections. |
| `DEFAULT_SEND_LIMIT_PER_HOUR` | no (`20`) | Emails each user's AI may send per hour. |
| `DATA_DIR` | no (`/data`) | Where the SQLite database lives. |
| `PORT` | no (`3000`) | Listen port. |

When both allowlists are set, a sign-in must pass **both**: the email domain must be in `ALLOWED_EMAIL_DOMAINS` **and** the IMAP host must be in `ALLOWED_IMAP_HOSTS` (unless it is `*`). A list that is not set does not restrict, so `ALLOWED_EMAIL_DOMAINS` alone allows any public mail server for those domains. The check runs at sign-in, when SMTP settings change, and again before each new mail connection.

`ALLOWED_SMTP_HOSTS` restricts outgoing servers separately: when it lists hosts, users can only save an SMTP server from that list, and every send checks it again before the SMTP password leaves the server. A stored SMTP server that is not on the list (for example a discovered one, or one saved before the list was set) does not block sign-in or reading mail; sending is refused and the settings page asks the user to pick an allowed server.

Server settings are auto-discovered on first sign-in (built-in presets, the domain's own autoconfig file at `https://autoconfig.<domain>/mail/config-v1.1.xml` or `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml` as Thunderbird reads it, the Thunderbird ISPDB, DNS SRV records, then the same file and ISPDB entry for the mail provider named by the domain's MX record, e.g. `provider.net` for a domain whose MX is `mx1.provider.net`), and the first successful sign-in pins the server for that address. Settings typed into the sign-in form are accepted only when discovery definitively finds nothing **and** the IMAP host is listed by name in `ALLOWED_IMAP_HOSTS` (`*` does not count). Otherwise, whoever signed in first with an address could point it at a server they control and capture the real owner's password at the owner's first sign-in. If the automatic lookup fails temporarily (for example the ISPDB or DNS is unreachable), sign-in is refused with a request to try again. Most company domains publish no discoverable settings, including Google Workspace and Microsoft-hosted ones, so for those domains list their IMAP server, e.g. `ALLOWED_IMAP_HOSTS=imap.gmail.com` or `ALLOWED_IMAP_HOSTS=mail.example.com`.

**Upgrading from an earlier version:** accounts created before this rule are re-confirmed at their next sign-in. They keep working if their IMAP host matches a built-in preset, is listed in `ALLOWED_IMAP_HOSTS`, or matches what discovery finds now. Otherwise sign-in and AI access are refused until you list the host. Before listing a host, check that it is your users' real server:
```bash
docker compose exec app node -e "const db=require('better-sqlite3')('/data/imap-connector.db'); console.table(db.prepare(\"SELECT email, imap_host, smtp_host FROM users WHERE settings_source = 'legacy'\").all())"
```
Delete any account whose server is not its owner's real mail server (`DELETE FROM users WHERE email = ?`); the owner can then sign in normally.

To change one user's send limit (run in the deployment directory):
```bash
docker compose exec app node -e "const db=require('better-sqlite3')('/data/imap-connector.db'); db.prepare('UPDATE users SET send_limit_per_hour = ? WHERE email = ?').run(50, 'someone@example.com')"
```

## Tools the AI gets

| Level | Tools |
|---|---|
| Read only | `list_folders`, `search_messages`, `get_message`, `get_thread`, `get_attachment` |
| Read and draft | + `set_flags`, `move_messages`, `create_draft` |
| Full access | + `send_email`, `delete_messages` (moves to Trash, never permanent) |

`get_attachment` reads attachments up to 5 MB and returns the text of plain-text, HTML and PDF files; other files are reported as binary. PDFs are parsed in a separate worker thread so a malformed or hostile file cannot stall the server: at most 15 seconds, 200 pages and 500,000 characters per file, a 256 MB memory limit, and no more than two PDFs at a time across all users. When a limit is hit, the tool's note says so (for example "Only the first 200 of 350 pages were read.").

## Security model

- **What is stored:** each user's email address, server settings, and mail password encrypted with AES-256-GCM using `ENCRYPTION_KEY`. OAuth codes and tokens are stored only as SHA-256 hashes.
- **What is never logged:** passwords, tokens, or message content.
- **Who can sign in:** only addresses or servers on your allowlist. Mail hosts resolving to private addresses are rejected unless `ALLOW_PRIVATE_HOSTS=true`. Connections go to the exact address that passed this check (TLS still verifies the hostname), so a second DNS answer cannot redirect them to an internal address.
- **Auto-discovery lookups:** a domain's autoconfig file is fetched over HTTPS only, without following redirects, from public addresses only (unless `ALLOW_PRIVATE_HOSTS=true`), with a 5-second timeout and a 64 KB size limit. As with mail connections, the request goes to the address that passed the check.
- **Outgoing mail:** with `ALLOWED_SMTP_HOSTS` set, a user's SMTP password is only ever sent to a listed server, checked again right before each send.
- **Prompt injection:** an email can contain text written to manipulate an AI. Email content is marked as untrusted for the model (between tags carrying a random per-response id, so an email cannot fake the end of its block), tools carry read-only/destructive hints so AI apps ask before sending, sending is rate-limited, and sending is off by default. These measures reduce the risk but cannot eliminate it. Only enable **Full access** if you accept that risk.
- Users can revoke any connected AI app, or delete their account, from the settings page.

## Deployment notes and known limitations

- **Plain-http `PUBLIC_URL`:** it works only for `localhost` / `127.0.0.1`, even with `NODE_ENV=development`. The MCP SDK rejects any other non-https issuer URL.
- **Run behind exactly one reverse proxy:** the app sets Express `trust proxy` to 1, as in the provided compose file with Caddy. If you expose the app directly without a proxy, clients can spoof `X-Forwarded-For` and weaken the per-IP sign-in rate limit.
- **Folder roles on servers without SPECIAL-USE:** roles such as `sent` or `trash` are resolved from the server's SPECIAL-USE flags, then from common English top-level folder names, then from localized top-level names (for example "Gesendet" or "Papierkorb"). If a role still does not resolve, tools that take a folder accept the exact folder path returned by `list_folders`; `create_draft`, saving to Sent after `send_email`, and `delete_messages` need the Drafts, Sent and Trash roles to resolve.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm test                 # unit tests
npm run test:integration # needs Docker (GreenMail test server)
npm run dev              # needs the env vars above; NODE_ENV=development allows http://localhost
```

Gmail's native thread search (`X-GM-EXT-1`) is not covered by the automated tests. Check it manually against a Gmail account before releases.

## Differences from the original project

Forked from [MinKyawNyunt/imap-mcp-connector](https://github.com/MinKyawNyunt/imap-mcp-connector) at commit `d9ffa03`. Changes since then:

- **Several mailboxes per person:** connector URLs of the form `/mcp/<label>`, so one AI app can hold a connector for each mailbox. With an email address as the label, sign-in is pre-filled and approval is limited to that mailbox. The settings page shows each mailbox's own `/mcp/<email>` URL in a field with a Copy button.
- **Better auto-discovery:** besides the presets, the ISPDB and SRV records, settings are now read from the domain's own autoconfig file and, as a last step, from the mail provider named by the domain's MX record. Domains that publish their settings only this way no longer need hand-entered settings.
- **`ALLOWED_SMTP_HOSTS`:** a separate allowlist for outgoing servers, so a user's SMTP password can only be sent to an approved server.
- **Safer PDF attachments:** PDF text is extracted in a worker thread with time, page, size and memory limits, so a crafted PDF cannot block the server.
- **Dependency upgrades:** production dependencies with known vulnerabilities were upgraded (zod 4, html-to-text 10, newer nodemailer, mailparser, fast-xml-parser and MCP SDK); `npm audit --omit=dev` reports none. Install scripts are allowed explicitly only for better-sqlite3 and esbuild.
- **Tested** on claude.ai and in the Claude Desktop app.

## License

MIT. Mail provider presets are adapted from [nikolausm/imap-mcp-server](https://github.com/nikolausm/imap-mcp-server) (MIT); see `THIRD_PARTY_NOTICES.md`.
