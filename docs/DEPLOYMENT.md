# Running the pixelguard dashboard

This guide covers every supported way to run the dashboard, from a quick local look to a shared team instance. Ticket: P047.

**Why there's no hosted deployment:** pixelguard keeps its data on disk (a SQLite database plus folders of screenshots) and the dashboard has no user accounts. It is meant to run next to the captures it shows: on your computer, a CI box or a small team server. If you want others to see it, share it read-only behind a password (see [Sharing with your team](#sharing-with-your-team)) rather than putting it on the public internet.

## Pick a setup

| You want to…                           | Use                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Look at your runs while developing     | [From source](#from-source)                                            |
| Run it without Node on your computer   | [Docker](#with-docker)                                                 |
| Keep it running on a server            | [Built version](#built-version) + [a service](#keep-it-running)        |
| Let teammates look without changing it | Any of the above + [read-only and a password](#sharing-with-your-team) |

Whichever you pick, the dashboard reads the same things `pixelguard diff` writes:

- the database in `DATABASE_URL` (default `./pixelguard.db`)
- screenshots in `OUTPUT_DIR` (default `./screenshots`)
- diff images in `DIFF_DIR` (default `./diffs`)

Image paths are saved relative to the folder `pixelguard diff` ran in, so **start the dashboard from that same folder** (Docker handles this for you).

## From source

Needs Node 20 or newer.

```bash
npm install
npx playwright install --with-deps chromium   # only needed for capture
cp .env.example .env                          # set TARGET_BASE_URL at least
npm run dev:dashboard                         # http://127.0.0.1:8100
```

Stop it with Ctrl+C.

## Built version

Faster to start and doesn't need the development tools once built.

```bash
npm ci
npm run build
npm start                                     # same as: node dist/cli.js dashboard
```

To make it lighter afterwards, run `npm prune --omit=dev`. Only `node_modules`, `dist/`, `public/` and `package.json` are needed to run it.

Options work the same everywhere: `npm start -- --port 9000 --read-only`, or set them in `.env`:

| Setting               | Default                  | What it does                                                                |
| --------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `DASHBOARD_HOST`      | `127.0.0.1`              | Who can connect. `127.0.0.1` = this computer only; `0.0.0.0` = your network |
| `DASHBOARD_PORT`      | `8100`                   | Port to listen on                                                           |
| `DASHBOARD_READ_ONLY` | `false`                  | `true` turns off accepting and restoring baselines                          |
| `DATABASE_URL`        | `sqlite:./pixelguard.db` | Which runs to show                                                          |
| `OUTPUT_DIR`          | `screenshots`            | Captures, needed for accepting and for baseline history                     |

`TARGET_BASE_URL` is required by every command, including `dashboard`. The dashboard doesn't use it, so on a machine that only runs the dashboard any valid URL will do.

## With Docker

See [Run with Docker](../README.md#run-with-docker) in the README. In short:

```bash
cp .env.example .env
docker compose up -d --build                  # http://localhost:8100
```

The compose file restarts the dashboard automatically (`restart: unless-stopped`), so it comes back after a reboot as long as Docker starts with your computer. For read-only, add `DASHBOARD_READ_ONLY=true` to `.env`.

## Keep it running

### Linux (systemd)

Create `/etc/systemd/system/pixelguard.service`, using the folder you built pixelguard in:

```ini
[Unit]
Description=pixelguard dashboard
After=network.target

[Service]
Type=simple
User=pixelguard
WorkingDirectory=/opt/pixelguard
# .env in WorkingDirectory is read automatically.
ExecStart=/usr/bin/node dist/cli.js dashboard
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pixelguard
journalctl -u pixelguard -f                   # logs
```

`systemctl stop` sends SIGTERM, which the dashboard handles cleanly: it stops the server and closes the database.

### Windows

The simplest option is Docker Desktop with the compose file above. Without Docker, start it when you sign in with Task Scheduler:

1. Build it once: `npm ci` then `npm run build` in the pixelguard folder.
2. Task Scheduler → **Create Task** → Triggers: **At log on**.
3. Actions → **Start a program**: program `cmd.exe`, arguments `/c npm start`, **Start in** your pixelguard folder (for example `C:\Users\you\Projects\pixelguard`).

### macOS

Use Docker Desktop, or keep `npm start` running in a terminal tab.

## Sharing with your team

By default only your own computer can open the dashboard. Anyone who can open it can accept changes and restore baselines, and there is no login, so when you share it:

1. **Turn on read-only** (`DASHBOARD_READ_ONLY=true` or `--read-only`). Runs, diffs, trends and baseline history are all still visible, and the page shows the `pixelguard accept …` command to run instead of the buttons. The server refuses the actions too, not just the page.
2. **Put a password in front of it** with a reverse proxy, which also gives you HTTPS.
3. Keep the dashboard itself on `127.0.0.1` so people can only reach it through the proxy.

### Caddy (automatic HTTPS)

```
pixelguard.example.com {
	basic_auth {
		# caddy hash-password --plaintext 'a long password'
		team $2a$14$replace.with.your.hash
	}
	reverse_proxy 127.0.0.1:8100
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    server_name pixelguard.example.com;
    # ssl_certificate / ssl_certificate_key ...

    auth_basic "pixelguard";
    auth_basic_user_file /etc/nginx/pixelguard.htpasswd;   # htpasswd -c ... team

    location / {
        proxy_pass http://127.0.0.1:8100;
        # Required: accept/restore check that requests come from the
        # dashboard's own address, which needs the original Host header.
        proxy_set_header Host $host;
    }
}
```

Without `proxy_set_header Host $host`, accepting or restoring from the page fails with "only allowed from the dashboard itself". Caddy passes the header on by default.

### Just your local network

For a quick share in the office, set `DASHBOARD_HOST=0.0.0.0` (and `DASHBOARD_READ_ONLY=true`), allow the port through your firewall, and open `http://<your-computer's-IP>:8100`. With Docker, change the port line in `docker-compose.yml` to `"8100:8100"` instead.

## Your data

| What             | Where (default)                    | Notes                                                                                                  |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Run history      | `pixelguard.db` (+ `-wal`, `-shm`) | Created on first use; upgraded automatically                                                           |
| Captures         | `screenshots/<tag>/`               | `baseline` and `current` are replaced by each capture                                                  |
| Baseline history | `screenshots/_history/<tag>/`      | The newest 20 versions are kept                                                                        |
| Diff images      | `diffs/<baseline>-vs-<current>/`   | Replaced by the next diff of the same two tags, so older runs show a placeholder for their diff images |

- **Backups:** stop the dashboard, then copy the database with its `-wal` and `-shm` files and the `screenshots/` folder. With the `sqlite3` tool you can back up while it runs: `sqlite3 pixelguard.db ".backup pixelguard-backup.db"`.
- **Cleaning up:** old diff images can be deleted any time. The dashboard shows a placeholder for images that are gone, and the run history stays.
- **Docker:** everything lives in `./pixelguard-data`.

## Upgrading

```bash
git pull
npm ci
npm run build
# then restart: systemctl restart pixelguard, or stop/start npm start
```

With Docker: `git pull` then `docker compose up -d --build`. The database is upgraded automatically on start. Back it up first if you care about the history.

## Troubleshooting

| Problem                                                 | Fix                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Port 8100 is already in use`                           | Something else uses the port. Use `--port 9000` or `DASHBOARD_PORT`                                          |
| Works on your computer, not from another one            | It listens on `127.0.0.1` by default. Set `DASHBOARD_HOST=0.0.0.0`, check the firewall, or use a proxy       |
| Can't reach it from outside the Docker container        | Compose sets `DASHBOARD_HOST=0.0.0.0` for you. With plain `docker run`, pass `-e DASHBOARD_HOST=0.0.0.0`     |
| "Only allowed from the dashboard itself" when accepting | Behind nginx: add `proxy_set_header Host $host;`                                                             |
| "This dashboard is read-only"                           | It was started with `--read-only` or `DASHBOARD_READ_ONLY=true`. Use the command shown, or turn it off       |
| Screenshots show "no longer available"                  | The files were deleted or moved, or the dashboard was started from a different folder than `pixelguard diff` |
| `TARGET_BASE_URL is required`                           | Every command needs it; for a dashboard-only machine any valid URL is fine                                   |
| No runs listed                                          | Check it reads the same `DATABASE_URL` as your diffs, and that you didn't use `diff --no-save`               |
| Check it's alive                                        | `curl http://127.0.0.1:8100/api/health` returns `{"status":"ok",…}`                                          |
