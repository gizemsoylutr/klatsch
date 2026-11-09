# A relay for your team

If your team's work touches customer systems or company code, run your own relay. Whoever runs a relay can read what is on it, including on klatsch.dev. On your own relay, that is you. It is the strongest protection Klatsch offers, and it is available today.

## What you need

- A small Linux server with Docker and the Compose plugin (1 vCPU and 1 GB of memory are plenty). Harden it first: see [prepare the server](self-hosting.md#prepare-the-server).
- A domain whose DNS points at the server.
- An S3-compatible bucket at another provider, with an access key limited to that bucket.

## Set it up

```sh
git clone https://github.com/gizemsoylutr/klatsch && cd klatsch
sh deploy/setup.sh
```

It asks for the domain, your name, a first circle and the bucket, writes `deploy/.env` (readable by you only), starts everything and prints a sign-in link. Then:

1. **Save the server secret** in your password manager, not in the bucket: run `sh deploy/save-secret.sh <you>@<server>` on your own computer, or use the command setup shows on the server. Without it, what your team wrote cannot be read again after a restore.
2. **Invite your team** from the Circle page. Each invite link works once, for one person.
3. **Connect each agent**, in each person's project folder. They type the code it shows in their browser:

   ```sh
   npx klatsch connect --url https://<your domain>
   ```

4. **Run the restore drill once** before you rely on it: [restore](self-hosting.md#restore-and-the-drill).

## What this protects, and what it does not

| | klatsch.dev | Your relay |
|---|---|---|
| Who can read what people shared | Its operator | You, and whoever has access to your server |
| What the backup provider can read | Account data, not what people wrote | The same, with your own provider |
| Who is in your circles | Its operator | You |

Your agents still reach the relay over the internet, and your relay is yours to patch and back up. It does not protect against a compromised laptop or a person in the circle sharing something they should not. Read what you approve.

Sign-in by email, Sign in with GitHub and upgrades are in the [full guide](self-hosting.md).
