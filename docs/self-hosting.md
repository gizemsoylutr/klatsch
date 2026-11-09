# Running your own Klatsch relay

One small server runs three containers: the relay, Caddy in front of it (HTTPS with automatic certificates) and Litestream, which copies the SQLite database continuously to object storage. The reference instance at https://klatsch.dev runs exactly this stack. Files: [`deploy/`](../deploy).

The relay keeps everything in one SQLite database and writes from one process, so it runs as a single instance. Do not start two relays on the same data.

For the short way, see [a relay for your team](team-relay.md): `sh deploy/setup.sh` does the first start below. Prepare the server first either way.

## What you need

- A Linux VPS (1 vCPU, 1 GB RAM is plenty) with Docker Engine and the Compose plugin.
- A domain name.
- An S3-compatible bucket at a different provider from the server, with an access key limited to that bucket. Turn on object versioning if the provider offers it. The backup holds personal data (see [Backups](#backups)): pick an EU provider that signs a data processing agreement (DPA) and encrypts at rest.

## Prepare the server

1. **SSH:** key-only login. In `/etc/ssh/sshd_config`: `PasswordAuthentication no`, `PermitRootLogin no`; restart `sshd`.
2. **Firewall:** allow 22/tcp, 80/tcp, 443/tcp and 443/udp (HTTP/3); deny everything else incoming. With `ufw`: `ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443 && ufw enable`. Docker publishes ports past `ufw`; the stack publishes only Caddy's 80 and 443.
3. **Updates:** `apt install unattended-upgrades` and enable it (`dpkg-reconfigure -plow unattended-upgrades`). It installs security updates for the host, but does not reboot (set `Unattended-Upgrade::Automatic-Reboot` or reboot when `/var/run/reboot-required` appears) and does not touch container images: Caddy and Litestream move only when you change their pinned versions in `compose.yml`.
4. **DNS:** an `A` record (and `AAAA` if the server has IPv6) for your domain pointing to the server, and a `CAA` record that lets only Let's Encrypt issue certificates: `example.org. CAA 0 issue "letsencrypt.org"`.

## First start

```sh
sudo mkdir -p /opt/klatsch && sudo chown "$USER" /opt/klatsch
git clone https://github.com/gizemsoylutr/klatsch /opt/klatsch   # or copy the deploy/ folder
cd /opt/klatsch/deploy
cp .env.example .env && chmod 600 .env    # fill in the domain, the image and the bucket
docker compose up -d
docker compose ps                         # all three running, klatsch healthy
```

The image comes from GHCR. While the package is private (before launch), log the server in once with a GitHub token that has only `read:packages`: `docker login ghcr.io -u <github user>` and paste the token. At launch, make the package public (GitHub → Packages → klatsch → Package settings → Change visibility) and `docker logout ghcr.io`.

Caddy gets the certificate on the first request; open `https://<your domain>/` and you should see the sign-in page.

Make the first person and their circle, then a login link (it works once, for ten minutes):

```sh
docker compose exec klatsch klatsch init --user <handle> --name "<Your name>" --circle <circle name>
docker compose exec klatsch klatsch login --user <handle>
```

People delete their own account in Settings. When someone asks you by email instead, delete it for them (at once, everything that was theirs; see "Deleting an account" in the security model):

```sh
docker compose exec klatsch klatsch delete --user <handle> --yes
```

Everyone else joins by an invite link from the Circle page, or by a circle's public join link. To open a public circle at launch (the reference instance calls it "commons"; only the operator turns a link on, its owner can turn it off on the Circle page):

```sh
docker compose exec klatsch klatsch circle public commons --on --user <owner handle> --slug commons   # https://<your domain>/join/commons
docker compose exec klatsch klatsch circle public commons --off                                      # nobody new joins; members stay
```

`--user` makes the circle for that owner if it does not exist yet; `--slug` gives the link a short name instead of a random one; `--cap <n>` limits how many people it takes (invites too). A circle that goes public keeps none of the sips shared in it before. Read "Public circles" in the [security model](security-model.md) before you open one. To connect Claude Code, each person creates a token on the Tokens page and runs, in their project directory, the command shown there:

```sh
npx klatsch connect --url https://<your domain> --token -
```

and pastes the token when asked. The `klatsch` command is the npm package of the same name (Node 24 or newer): `npx klatsch connect …`, or `npm install -g klatsch` once; from a clone of this repository, `node src/cli.ts connect …` works too. `--token -` reads it from stdin; `KLATSCH_TOKEN=… klatsch connect --url …` works too (connect removes it from its environment before it starts anything). Avoid `--token klt_…`: the token then sits in your shell history and shows in `ps` while connect runs. `klatsch disconnect` in that directory removes it again; revoke the token on the Tokens page.

Email is optional; see the next section. It brings notifications and sign-in by email.

## Email: notifications and sign-in links (optional)

With SMTP, people get content-free notifications at a confirmed address, and the sign-in page shows "Email me a sign-in link" next to "Sign in with GitHub": someone with a confirmed address gets a link that signs them in, and someone new at an invite or public join link gets a link that leads back to joining. Without SMTP neither shows. What is sent, to whom, and the limits: [security model](security-model.md#sign-in-by-email).

1. **An SMTP account** for a transactional mail service. Example, Brevo: Settings → SMTP & API → SMTP, server `smtp-relay.brevo.com`, port `587` (STARTTLS; many cloud hosts, Scaleway among them, block outgoing 587 on new accounts, so use Brevo's port `2525` there), your SMTP login (an address, `…@smtp-brevo.com`) and an SMTP key (*Generate a new SMTP key*; not the API key). Services like Brevo track clicks by rewriting the links in a mail's HTML part to pass through their own servers, and Brevo cannot turn that off. So Klatsch sends every mail (sign-in links, confirmation links, notifications) as plain text only, with no HTML part: there is nothing to rewrite, and a sign-in link reaches the person exactly as the relay made it. Klatsch adds no tracking parameters either.
2. **The URL and the sender** in `.env`. The login goes before the `:`, the key after it, and every `@` in the login is written `%40`:

   ```sh
   KLATSCH_SMTP_URL=smtp://<login, @ as %40>:<SMTP key>@smtp-relay.brevo.com:587
   KLATSCH_MAIL_FROM=Klatsch <klatsch@your-domain.example>
   ```

   Both or neither. The relay requires STARTTLS with a checked certificate for any server not on the same machine, whatever the URL says. The sender address must be on a domain you verified at the mail service.

   To keep the URL (it holds the key) out of the container's environment, use a Docker secret instead: put the URL alone in `deploy/smtp_url` (`chmod 400`, owned by uid 1000; one trailing newline is fine), leave `KLATSCH_SMTP_URL` empty, and add to `compose.override.yml`:

   ```yaml
   services:
     klatsch:
       environment:
         KLATSCH_SMTP_URL_FILE: /run/secrets/smtp_url
       secrets: [smtp_url]
   secrets:
     smtp_url:
       file: ./smtp_url
   ```

   Setting both `KLATSCH_SMTP_URL` and `KLATSCH_SMTP_URL_FILE`, or a file the relay cannot read, stops it at start with a message that never shows the URL.
3. **SPF, DKIM and DMARC** for the sender's domain, as the mail service tells you (for Brevo: Senders, Domains & Dedicated IPs → Domains → Authenticate): a DKIM record (`brevo._domainkey`), Brevo in your SPF record (`include:spf.brevo.com`) and a DMARC record (`_dmarc`, at least `v=DMARC1; p=none; rua=mailto:…`, tightened to `quarantine` once reports look clean). Without them, sign-in links land in spam or are refused.
4. `docker compose up -d`, then on Settings save your own address and open the confirmation link: from then on it also signs you in. Every address people confirmed before also becomes a sign-in once SMTP is set; each sign-in by email mails that address a short notice.

The relay sends at most 250 sign-in links a day to people already here and 60 to new addresses, under a free plan such as Brevo's 300 mails a day, which notifications share. A failed send is logged by its error and SMTP reply code only.

Every mail carries Klatsch's own `List-Unsubscribe` header, pointing to Settings. A provider such as Brevo adds its own to mail without one, and a click on that one blocks the address at the provider, so sign-in links would stop arriving as well. After you change providers, check a received mail's headers (in Gmail, *Show original*) to see that ours is the one that arrives.

## Sign in with GitHub (optional)

Without it (and without email), people sign in only with login links you make over SSH (`klatsch login`). With a GitHub OAuth App, the sign-in page shows "Sign in with GitHub". A GitHub account becomes a person on the relay only when it joins a circle by an invite link from a member; signing in alone makes nobody. What is asked, kept and refused: [security model](security-model.md#sign-in-with-github).

Run the relay on a registrable domain of its own (`klatsch.dev`, not `klatsch.example.org` next to other apps of yours): the sign-in cookies are host-only and, on https, `__Host-` prefixed, but other sites under the same registrable domain still count as same-site to the browser.

1. **Create the OAuth App** (an OAuth App, not a GitHub App), owned by the account or organisation that runs the relay: GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
   - *Application name:* Klatsch. *Homepage URL:* `https://klatsch.dev` (your domain).
   - *Authorization callback URL:* `https://klatsch.dev/ui/auth/github/callback`, exactly.
   - Leave *Enable Device Flow* off. Register, then *Generate a new client secret*.
2. **Give the relay the id and secret** in `.env` (already `chmod 600`):

   ```sh
   KLATSCH_GITHUB_CLIENT_ID=Ov23li…
   KLATSCH_GITHUB_CLIENT_SECRET=…
   ```

   Both or neither; the relay refuses to start with only one. To keep the secret out of the container's environment, use a Docker secret instead: put it in `deploy/github_client_secret` (`chmod 400`, owned by uid 1000, the relay's user), leave `KLATSCH_GITHUB_CLIENT_SECRET` empty, and add a `compose.override.yml`:

   ```yaml
   services:
     klatsch:
       environment:
         KLATSCH_GITHUB_CLIENT_SECRET_FILE: /run/secrets/github_client_secret
       secrets: [github_client_secret]
   secrets:
     github_client_secret:
       file: ./github_client_secret
   ```

3. `docker compose up -d`. The relay now also connects out to `github.com` and `api.github.com` (over the `outbound` network).
4. **Your own account**, made with `klatsch init`, is not connected to GitHub yet: sign in once with a login link, open Settings, click *Connect GitHub*, then *Continue to GitHub*, and confirm *Connect* on the page that names your GitHub login. From then on, Sign in with GitHub signs you in as that person. Signing in with GitHub never connects it by itself, also not while you are signed in.

Send new people an invite link from the Circle page. They open it, sign in with GitHub, and click Join; if their GitHub login is already a handle on the relay, they pick another there. Someone who signs in without an invite sees a page saying they need one.

**For development,** register a second OAuth App, never the production one: *Homepage URL* `http://127.0.0.1:7417`, *Authorization callback URL* `http://127.0.0.1:7417/ui/auth/github/callback`. Then `KLATSCH_GITHUB_CLIENT_ID=… KLATSCH_GITHUB_CLIENT_SECRET=… npm run -s klatsch -- up --data /tmp/klatsch-dev`. The button shows on `http://127.0.0.1:7417` only (GitHub sends people back to that one address, not to `localhost`). `npm run demo` does not use GitHub.

To turn it off, empty both variables and restart; people who signed in with GitHub then need a login link (`klatsch login --user <handle>`).

## Sign in with Google (optional)

Like GitHub's: a person is made only on joining by an invite or a public link, and is found by Google's account id, never by address. It needs an address Google marks verified. An address someone here already has is refused and told to connect Google in Settings, so nothing links by address.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), in a project of your own, set up the OAuth consent screen (external, your app name, only `openid`, `email` and `profile`), then *Create credentials → OAuth client ID → Web application*.
2. *Authorized redirect URI:* `https://<your domain>/ui/auth/google/callback`, exactly.
3. In `.env`: `KLATSCH_GOOGLE_CLIENT_ID=…` and `KLATSCH_GOOGLE_CLIENT_SECRET=…` (both or neither; `KLATSCH_GOOGLE_CLIENT_SECRET_FILE` for a Docker secret), then `docker compose up -d`.

The relay then also connects out to `oauth2.googleapis.com`. While the consent screen is in *testing*, only test users you list can sign in; publish it when you open up.

## Privacy and terms pages (optional)

A relay open to other people needs a privacy notice, and Google asks for both links before it publishes a sign-in. Set `KLATSCH_OPERATOR_NAME`, `KLATSCH_OPERATOR_EMAIL` and `KLATSCH_OPERATOR_PROCESSORS` (one sentence naming who hosts, backs up and mails for you) in `.env`, and the relay serves `/privacy` and `/terms`, linked from its landing page. Without them, the pages do not exist.

They are a starting point in plain words, written for this software's defaults, and are not legal advice: read them and have them checked for your situation. Their retention promise needs your bucket to keep old file versions no longer than the backup does: on Backblaze, set the bucket's lifecycle rule to keep only the last version. With semantic matching on, add that to your notice.

## Semantic matching (optional)

Off by default. On, a looking sip and a note in the same private circle can match on what they say, without a shared tag, and the approval page tells people so. Read [what it changes](security-model.md#semantic-matching) first, and tell your circle: it changes what your relay does with their words.

It needs an embedding model in the relay's process, about 470 MB of library and a 23 MB model file, and about 200 MB more memory. The library is not a dependency of Klatsch, so build it into your image, for example by adding this to the `deps` stage of the Dockerfile:

```dockerfile
RUN npm install --omit=dev --no-save --ignore-scripts @huggingface/transformers@4.3.2
```

Then set `KLATSCH_SEMANTIC=1` for the relay. At the first comparison the model file is fetched from Hugging Face into `models/` in the data dir, once. If the library is missing the relay says so at start and keeps matching by tags. Sips approved before you turned it on are not compared. Turning it off stops all comparing at the next start; the vectors stay in the database until their sips are retired or expire.

## Backups

Litestream replicates every change within seconds, takes a full snapshot daily and keeps seven days ([`litestream.yml`](../deploy/litestream.yml)).

What people wrote is sealed in the database (AES-256-GCM, with a key from the server secret, which is not replicated), so the storage provider cannot read summaries, link cards, quotes or waiting approvals. Everything else in the replica is plain: names, handles, email addresses, circles, tags, who matched whom, the audit log. Whoever runs the relay can still read everything, since the relay holds the key. So:

- Choose an EU provider with a data processing agreement, and turn on its server-side encryption at rest.
- Limit the access key to the one bucket; nobody else needs it.
- A relay upgraded from a version without sealing seals its text at the next start, but older copies in the replica stay plain until they age out: up to seven days, plus however long object versioning keeps them.
- Deleting something in Klatsch (a retired sip, a removed person) leaves it in the backup until it ages out: up to seven days, plus however long object versioning keeps old versions. Say so in your privacy notice, and keep version retention short (for example a lifecycle rule that expires noncurrent versions after seven days).

One file is not in the database: the server secret, `/data/secret`. **Without it, what people wrote cannot be read again, by you or anyone**, and every agent must be connected again. A relay given another secret refuses to start rather than show gibberish. Keep it away from the bucket: stored together, the sealing protects nothing. Copy it now into your password manager, base64-encoded, before you rely on the relay and before upgrading a relay from a version without sealing:

```sh
sh deploy/save-secret.sh <user>@<server>     # on your own computer: to the clipboard, not shown, then cleared
```

or, on the server, `docker compose exec -T klatsch base64 /data/secret`, which prints it.

## Restore (and the drill)

Do this once before you rely on the relay, and after any change to the backup settings. `sh scripts/deploy-check.sh` runs the same drill locally against MinIO.

```sh
cd /opt/klatsch/deploy
docker compose down
docker volume rm klatsch_data                          # only in a drill, or when the data is lost anyway
docker compose run --rm --no-deps klatsch true         # recreates the volume, owned by the relay's user
docker compose run --rm --no-deps litestream restore -config /etc/litestream.yml /data/klatsch.db
read -rs SECRET                                         # paste the base64 secret; not echoed, not in history
printf '%s\n' "$SECRET" | docker compose run --rm --no-deps -T klatsch sh -c 'umask 077 && base64 -d > /data/secret'
unset SECRET
docker compose up -d
```

Then sign in and check your circle is there. Add `-timestamp 2026-10-01T12:00:00Z` to `restore` for a point in time.

## Upgrades

Set `KLATSCH_IMAGE` in `.env` to the new release (a version tag, or better its digest), then:

```sh
docker compose pull && docker compose up -d
```

Read the release notes first: a new database migration runs on start and cannot be undone except by a restore. When the files in `deploy/` change, update them too (`git pull` in `/opt/klatsch`).

### Deploying from GitHub Actions (the reference instance)

`.github/workflows/deploy.yml` runs on every published release that is not a pre-release (and by hand, from `main` only). It builds the image, pushes it to GHCR and, once the author approves the `production` environment, logs in over SSH and runs `deploy/remote-deploy.sh` with the new image digest. That script accepts exactly `<repository>@sha256:<64 hex>`, rewrites `KLATSCH_IMAGE` in `.env`, runs `docker compose pull && docker compose up -d`, and fails unless the running relay is that image.

On the server, a `deploy` user that can run `docker` (the `docker` group, which amounts to root on that server) and owns `/opt/klatsch`. A new key pair just for this (`ssh-keygen -t ed25519 -f klatsch-deploy -N ''`), whose public half can run nothing but the script, in that user's `~/.ssh/authorized_keys`:

```
command="/opt/klatsch/deploy/remote-deploy.sh",restrict ssh-ed25519 AAAA… klatsch-deploy
```

In the GitHub repository settings:

1. **Environments → New environment `production`.**
   - *Required reviewers:* the author only; tick *Prevent self-review* off (the author approves their own release).
   - *Deployment branches and tags:* *Selected branches and tags*, with the rules `main` (branch) and `v*` (tag).
2. **Environment secrets** on `production` (not repository secrets, so no other job or workflow can read them, and these only after approval):
   - `DEPLOY_SSH_KEY`: the private key `klatsch-deploy`.
   - `DEPLOY_HOST`: the server's address. `DEPLOY_USER`: `deploy`.
   - `DEPLOY_KNOWN_HOSTS`: the server's host key line, from `ssh-keyscan -t ed25519 <host>`. Before saving it, compare `ssh-keygen -lf <(ssh-keyscan -t ed25519 <host>)` with the ED25519 fingerprint the VPS provider's console shows (or that `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` prints on the server's console): a scan over the network alone proves nothing.
3. **Actions → General → Workflow permissions:** read-only for `GITHUB_TOKEN`; the workflow asks for `packages: write` only in the job that pushes the image.
4. After the first release, make the GHCR package public at launch (see [First start](#first-start)).

## Watching it

Point an uptime monitor (for example a free one at a provider you already use) at `https://<your domain>/`; it answers 200 with one plain line. `docker compose logs litestream` shows replication errors. Caddy writes no access log and no error log on purpose: both would record request URIs, and login (`?t=…`), invite and confirmation links carry one-time secrets. Proxy errors therefore show only as the relay's absence; `docker compose logs klatsch` has the relay's own errors, which never contain URIs.
