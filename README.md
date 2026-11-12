# Nova AI (@llyverse/nova)

Nova is the resident AI of the LLYVerse. This package holds all of Nova's code so
the LLYVerse site can load her as a module instead of keeping her files inside
the site:

- **Chat and memory**: `lib/nova_chat.js`, `lib/nova_jobs.js`, `lib/nova_usage.js`
- **The approved persona**: `prompts/nova-persona.md` (loaded by `lib/nova_persona.js`;
  an admin override in Settings still wins if set)
- **Layout v3 (simpler menus)**: `lib/nova_menu.js`, `views/partials/nova/*_v3.ejs`,
  `v3_item.ejs`, `v3_panels.ejs`, `public/css/nova-v3.css`, `public/js/nova/nova-v3.js`.
  See [docs/nova-layout.md](docs/nova-layout.md).
- **Member plugins** (Gmail, GitHub, Notion, Slack and more): `lib/nova_plugins/`,
  `lib/nova_plugins_router.js`, `views/nova_plugins.ejs`. See [docs/nova-plugins.md](docs/nova-plugins.md).
- **Approvals, routines, secrets, push, MCP tools, live workstation**: the other `lib/nova_*.js` files
- **Routes**: `lib/nova.js` (mounted at `/api/nova`) and `lib/nova_plugins_router.js`
- **Middleware**: `middleware/nova-lockdown.js`, `requireNovaUser.js`, `requireApprovalToken.js`
- **Pages and assets**: `views/` and `public/` (served by the site at the same URLs as before)
- **Database tables**: `lib/migrations.js` (`runMigrations(db)`, every statement is
  `IF NOT EXISTS`, so it never touches existing data)
- **Backups**: `scripts/nova_backup.js`, `scripts/nova_restore.js`

## How the site loads Nova

Nova borrows three things from the site instead of owning them: the database
helpers, the AI client and the MCP server list. The site hands them over once at
start-up, before it loads anything else from Nova:

```js
const nova = require('@llyverse/nova');
nova.configure({
  rootDir: __dirname,                                   // where .env and data/ live
  db: () => require('./data/db'),
  cloudflareAi: () => require('./services/cloudflare-ai'),
  mcpServers: () => require('./services/mcp_servers')
});

app.set('views', [path.join(__dirname, 'views'), nova.viewsPath]);
app.use(express.static(nova.publicPath));
app.use('/api/nova', nova.createNovaRouter(/* same options as before */));
```

Every other export (`novaChat`, `novaMenu`, `novaPlugins`, `requireNovaUser`, ...)
loads on first use. In the LLYVerse site, the old file paths
(`services/nova_chat.js` and so on) are one-line pointers to this package, so the
rest of the site did not have to change.

The site installs this package straight from GitHub:

```json
"@llyverse/nova": "github:annapreston7991-cell/NovaAi#v1.1.0"
```

## Settings (.env)

Copy what you need from [.env.example](.env.example) into the site's `.env`.
Never commit `.env`. The important ones:

- `NOVA_UI_V3`: layout v3 is on for everyone by default. Set `NOVA_UI_V3=false`
  and restart to put everyone back on the old layout.
- `NOVA_SECRETS_KEY`, `NOVA_BACKUP_KEY`: created in `.env` on first start if missing.
  Don't change `NOVA_SECRETS_KEY` once set, or saved plugin connections stop working.
- `NOVA_PLUGIN_*`: one set per plugin. A plugin only shows for members when all its keys are set.
- `NOVA_COMPUTER_ENABLED`: `true` turns on the owner-only screen and computer tools.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`: needed for push notifications.

## Tests

```bash
npm install
npm test
```

`npm test` runs the name and secret scan, the package wiring checks, the layout v3
checks and the plugin checks. Checks that need the whole site database
(`scripts/test-nova-0.js`, `test-nova-computer.js`, `test-nova-mcp.js`) run from
the LLYVerse site, where Nova is installed.

## Older files kept for reference

`public/js/nova/nova-menu.js` is from the first package release and is no longer
loaded by the new layout. It is kept so nothing that already existed here was
removed; it can be deleted later.

## License
LLYVerse License 1.0. See [LICENSE](LICENSE). Credit to LLYVerse is required.
