# Klatsch ☕

**Your circle already knows.** Share what you learn, and find what the people you know already figured out. Your AI coding agent asks; people decide. Agents never see each other's text unless a person hands it over.

![Alice's agent asks to share that she is stuck on paging in a Node.js API on Postgres. Her browser shows the exact sip and she clicks Share. On her Home page, Bob's note on the same problem appears at once, with his name, because he left it open to their circle.](docs/assets/demo.gif)

## Why

You are stuck on something that a colleague, a former teammate or a friend solved last month. You don't know that, so you don't know who to ask. Your coding agent doesn't either: it knows your repository and the public web, not what the people around you have already figured out.

Klatsch is a small open-source relay that connects the agents of people who know each other, without letting them read each other. When you are stuck, your agent drafts one line about it. If someone in your circle solved the same thing, Klatsch finds them by tags, and the two of you decide what happens next.

## How it works

1. **Your agent drafts a sip.** Stuck, or just learned something? Your agent writes one line for your card: a status (`looking`, `solved`), a few tags from a fixed vocabulary, at most 200 characters.
2. **You share it, or not.** Nothing leaves your card until you click Share in your own browser. Your agent can ask; it can never approve. Possible identifiers (hostnames, emails, secrets) are flagged for you first.
3. **Klatsch matches tags.** Looking meets solved on shared tags, deterministically: no model reads several people's text (unless a relay's operator turns on semantic matching, below). Agents get ids, tags and counts, never another person's words or name.
4. **People decide.** If the person who solved it left their note open to the circle, you read it at once, with their name. Otherwise they read what you are stuck on and accept or decline your intro; names appear only when both accept. Either way, another person's text reaches your agent only when you send it there yourself.

Want one person's help? Tell your agent to **ask them directly**: only they read it, and only you read their answer. An open note can also go on the **Notes page**, if you tick that: everyone in your private circles can read it any time, so what you learned reaches people who were not looking for it. A solved note can be a **link card**: when a public post, doc or issue fixed it, your agent adds its link, and Klatsch shows the title with the site's address beside it (it never opens the link). And nobody has to start alone: a **commons** is a circle with a public join link. Your sips reach it only when you tick it on the approval page.

More detail: [how it works](docs/how-it-works.md), and every flow as a diagram drawn from the tests: [docs/flows](docs/flows/README.md).

## Quick start

macOS or Linux, Node 24 or newer, and an MCP client such as [Claude Code](https://code.claude.com). Windows is not supported yet (the reminder hook and the token helper are POSIX shell commands).

### From ChatGPT or Claude

Add `https://klatsch.dev/mcp` as a custom connector (ChatGPT: developer mode; Claude: Settings → Connectors), sign in to Klatsch in the page that opens, and approve the connection. Then ask in any chat, for example: *"Ask @sam on Klatsch how they set up their CI cache."* You approve it in a Klatsch card right in the chat, Sam reads and answers it in his, and the answer comes back to your chat. Add friends with "Add a friend" on the Circle page. Not yet run live with either app.

### Try it locally

```sh
npx klatsch up --demo
```

This starts a relay on `127.0.0.1:7417` with two people, Alice and Bob, signs both in in your browser, and prints a `connect` command for each. Bob has already solved cursor paging in a Node.js API on Postgres, open to the circle. Run Alice's `connect` line in a fresh terminal, then tell her Claude Code session:

> I'm stuck on pagination in my Node.js API: OFFSET paging on Postgres gets slow and skips rows. Share it on Klatsch and look for help.

Approve the share in Alice's browser, and Bob's note is on her page. Something off? See [troubleshooting](docs/troubleshooting.md).

### Use the hosted relay

The reference instance runs at [klatsch.dev](https://klatsch.dev). Private circles there grow by invite: open an invite link from someone in a circle, sign in with GitHub and join. Or start in the public commons from its join link, and invite your own people later. Then, in your project directory:

```sh
npx klatsch connect --url https://klatsch.dev
```

It shows a code and opens the relay in your browser; sign in, type the code, read what it means and click Connect. Without a browser on this machine, open the page on another device, or make a token on the **Tokens** page and use `--token -`. The token is stored in a 0600 file and handed to Claude Code through a helper command, never written into its configuration. `npx klatsch disconnect` undoes it.

Using Claude Code plugins? The [Klatsch plugin](docs/claude-code-plugin.md) adds the hosted server and a `/klatsch` command.

## Works with

`klatsch connect` sets up Claude Code by default; `--client codex`, `--client copilot-vscode` or `--client copilot-cli` sets up another agent in the same directory, with the same token file (0600, under `~/.klatsch/agents/`) and the same flags (`--user <handle> [--demo]`, or `--url https://<relay> --token -` for a hosted relay). No client config holds the token: each one runs a Klatsch command that reads the file. `klatsch disconnect --client <client>` removes what connect added for that client; the token is revoked (or, hosted, you are told to revoke it) once no client in the directory uses it. `klatsch disconnect` without `--client` undoes every client.

| | Claude Code | Codex | GitHub Copilot in VS Code | GitHub Copilot CLI |
|---|---|---|---|---|
| What connect writes | local-scope MCP server (`claude mcp add-json`), `.claude/settings.local.json` | `.codex/config.toml`, `.codex/hooks.json` in the directory | `.vscode/mcp.json` | `.mcp.json` in the directory, saved tool approvals in `~/.copilot/permissions-config.json` (`$COPILOT_HOME`) |
| How it gets the token | `headersHelper` | `http_headers_helper` | `klatsch mcp-proxy`, a local stdio server (VS Code has no header helper) | `klatsch mcp-proxy` |
| Approving a share or intro | the approval page opens from a dialog | a code and a link the agent shows you (Codex speaks MCP 2025-06-18) | a code and a link; the page from a dialog only if the client speaks 2026-07-28 with URL dialogs (not verified) | the same as VS Code (not verified) |
| Wakes an idle session (`watch`) | yes, in the terminal CLI | no | no | not verified |
| Reminder when you type | yes (prompt hook) | yes, once you trust the hook in `/hooks` | no (Copilot does not pass a prompt hook's output to the model) | no |
| Klatsch tools run without a prompt | allow rules | `approval_mode = "approve"` per tool | no setting for it: choose "Always allow" at the first call | saved approvals, which Copilot keeps per repository: they cover every folder in it |

Only Claude Code has been run end to end. The Codex setup was checked against the openai/codex source (main at `3026a8e`, 2026-11-02, after `rust-v0.166.0`) and its docs; the Copilot setup against the VS Code docs (microsoft/vscode-docs `84925c3`) and source (microsoft/vscode `37eba09`), the GitHub Copilot CLI docs (github/docs `b8fe410`) and the Copilot CLI changelog up to 1.0.105. None of them has been run live with Klatsch yet; `klatsch mcp-proxy` is tested with the official MCP client over stdio.

Per client:

- **Codex:** `klatsch connect --user <handle> --client codex`, then start `codex` in that directory, trust the project when asked (Codex reads `.codex/` only in trusted projects) and run `/hooks` to trust the Klatsch hook (again after a reconnect changes its command). The server entry is per project, not in `~/.codex/config.toml`, so every connected directory keeps its own token. Connect writes one marked block at the end of `.codex/config.toml` and stops if the file already defines a `klatsch` server some other way.
- **GitHub Copilot in VS Code:** `klatsch connect --user <handle> --client copilot-vscode`, open the folder in VS Code, start the `klatsch` server when asked, and pick "Always allow" for the Klatsch tools. Connect stops, without touching it, if `.vscode/mcp.json` has comments or trailing commas; remove them, or add the server by hand: `"servers": {"klatsch": {"type": "stdio", "command": "npx", "args": ["-y", "klatsch@<version>", "mcp-proxy", "--url", "<relay>", "--dir", "<this directory>"]}}` (add `"--data", "<dir>"` if you use one).
- **ChatGPT, claude.ai and other apps that connect by OAuth:** add `https://<relay>/mcp` as a custom connector (in ChatGPT, developer mode). The app opens a Klatsch page where you approve the connection; it then appears on your Tokens page, where you revoke it. Approvals of what it shares still happen on Klatsch's own pages. Not yet run live against these apps.
- **GitHub Copilot CLI:** `klatsch connect --user <handle> --client copilot-cli`, then start `copilot` in that directory and trust the folder (it loads `.mcp.json` only in trusted folders). Claude Code also reads a project `.mcp.json` and asks once whether to use its servers; the `klatsch` server there works for it too.

The files in the directory hold paths on this machine, not the token: keep `.codex/`, `.vscode/mcp.json` and `.mcp.json` out of git (connect warns when git would pick one up). For the Copilot CLI, disconnecting a folder below the repository root keeps the repository's approvals, since other connected folders there may use them, and says where to remove them.

## Privacy and security

- **An agent can ask, never approve.** Every share and every intro is decided in the human's own signed-in web session; an approval works once, for ten minutes, only for its owner.
- **Agents never get another person's text or name.** You can hand one note you read to your own agent, or choose to always get one person's notes; every "always" is listed in Settings and revoked with one click.
- **Matching is deterministic by default.** A model only ever reads its own human's data. An operator can turn on [semantic matching](docs/security-model.md#semantic-matching): a model inside the relay compares approved summaries in private circles and can only make a match; the approval page says so. It is off by default.
- **Public circles are opt-in per sip.** A sip reaches a public circle only when you tick it on its approval page; strangers there see no member list. Klatsch never fetches a link card's link.
- **Tokens** are scoped per tool, short-lived, revocable and stored as keyed hashes. The web UI runs no JavaScript and has a strict Content-Security-Policy.
- **Sealed at rest.** What people wrote is encrypted in the database with a key from the server secret, so a backup or a copied database file does not show it. This is not end-to-end encryption.
- **Limits, stated plainly:** whoever runs a relay can read everything on it; on your own machine, an agent with shell access runs as you. Run your own relay for a circle you do not want to trust to someone else.

The whole model, with what it does not protect against: [docs/security-model.md](docs/security-model.md). Found a hole? Please report it privately: [SECURITY.md](SECURITY.md).

## How it compares

Klatsch sits next to tools you may already use. The table describes each kind of tool as it usually works; a particular product may differ.

| | Who reads what you wrote | Who decides it is shared | Finds the people you know |
|---|---|---|---|
| **Klatsch** | People in your circle, after you approve; other agents only what a person hands over | You, per sip, in your browser; the other person decides on intros | Yes, by invite-only circles |
| Shared-memory MCP servers | Every agent connected to the store | Usually the agent that writes to it | No, it shares a store, not people |
| Team chat bots | The bot, and everyone in the channels it reads | Whoever posted in the channel | Within one workspace |
| Agent-to-agent rooms | The other agents in the room, directly | Usually the agents, within what their humans set up | Only who joins the room |
| Public Q&A and web search | Everyone | You, when you post publicly | No |

Klatsch is not a chat or a search engine. It carries what people learned to the people near them who need it, one approved line at a time, and lets two people meet when both want to.

## Run your own relay

Whoever runs a relay can read what is on it, so if your team's work touches customer systems or company code, run your own: [a relay for your team](docs/team-relay.md), with one setup command. One small server with Docker Compose: the relay, Caddy for HTTPS and Litestream for continuous backups to object storage. Details: [docs/self-hosting.md](docs/self-hosting.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md): every commit is signed off (DCO), every user-visible flow has an end-to-end test, and security-relevant changes come with a test that shows the rule holds. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache-2.0](LICENSE). Made by Gizem Soylu ([gizemsoylutr](https://github.com/gizemsoylutr)).
