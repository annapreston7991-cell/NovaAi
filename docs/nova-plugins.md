# Nova plugins: setup guide

Nova plugins let a signed-in member connect **their own** accounts (Gmail, GitHub and more) so Nova can look things up for them in chat.

## How it works

- **Each member's own account.** Members connect on **Nova > Settings > Plugins & connections** (`/novaai/plugins`) with the provider's normal sign-in (OAuth). Nobody can use another member's connection.
- **Tokens are encrypted at rest.** They're stored per member in `nova_secrets` (AES-256-GCM, key `NOVA_SECRETS_KEY`) under the target `plugin:<id>`. They never go to the browser, the chat, the model or the logs.
- **Members can revoke a connection.** "Disconnect" asks the provider to revoke the token, where the provider supports that, and then deletes Nova's copy.
- **Reads run straight away; writes ask first.** Anything that sends, posts, creates or deletes:
  - shows an approval card in the chat with the exact details;
  - runs only after the member presses Confirm;
  - uses a single-use, 5-minute token tied to those exact details;
  - can't be approved through the generic `/api/nova/approvals/mint` endpoint.
- **A plugin is only on when its keys are set.** If any key is missing, members don't see the plugin at all.
  - Wikipedia needs no key, so it is always on.
  - Stripe and Cloudflare are owner-only and read-only.
  - Setup status, missing key names and redirect URLs are listed on **Admin > Nova Plugins Setup** (`GET /api/admin/nova/plugins`, owner only). That page never shows key values.
- **Limits:** each member can run at most 20 plugin actions a minute. Nova can make at most 3 plugin calls per reply. Parameters are checked against a strict whitelist.

## Setting up a plugin

1. Create the developer app at the link shown below.
2. Paste the **redirect URL** exactly as shown. It is built from `NOVA_PLUGINS_BASE_URL`, which defaults to `https://llyverse.org`.
3. Put the client ID and secret (or the API key) in `/home/lily/ai-node/.env`. **Never commit `.env`.** `.env.example` lists every key with empty values.
4. Restart the server. The plugin now shows up for members, and its row on Admin > Nova Plugins Setup turns to "configured".

Google is one OAuth client shared by Gmail, Calendar, Drive, Docs and YouTube:

- Add all five redirect URLs to that client.
- Turn on the Gmail, Calendar, Drive, Docs and YouTube Data APIs.
- While the Google app is in "Testing" mode, add members as test users. Sensitive scopes such as Gmail need Google's verification before the app can be public.

## Plugins

### Gmail

Search and read your email, draft replies, and send mail you approve.

- **Keys:** `NOVA_PLUGIN_GOOGLE_CLIENT_ID`, `NOVA_PLUGIN_GOOGLE_CLIENT_SECRET`
- **Create the app:** https://console.cloud.google.com/apis/credentials (OAuth client ID, type "Web application"). Turn on the matching API in "APIs & Services > Library".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/gmail` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/gmail`)
- **Scopes:** `openid` `email` `https://www.googleapis.com/auth/gmail.readonly` `https://www.googleapis.com/auth/gmail.compose`
- **What Nova can do:**
  - Reads: Search email — Find recent emails. query uses Gmail search syntax (for example "from:shop is:unread").
  - Reads: Read an email — Open one email by id (from a search).
  - Asks first: Save a draft — Save an email draft in your Gmail (not sent).
  - Asks first: Send an email — Send an email from your Gmail.

### GitHub

See your repositories and issues, and open issues or comments you approve.

- **Keys:** `NOVA_PLUGIN_GITHUB_CLIENT_ID`, `NOVA_PLUGIN_GITHUB_CLIENT_SECRET`
- **Create the app:** https://github.com/settings/developers > OAuth Apps > New OAuth App. Put the redirect URL in "Authorization callback URL".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/github` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/github`)
- **Scopes:** `read:user` `repo`
- **What Nova can do:**
  - Reads: List my repositories — Your most recently updated repositories.
  - Reads: List open issues — Open issues in one repository (owner/name).
  - Asks first: Open an issue — Create a new issue in a repository you can write to.
  - Asks first: Comment on an issue — Add a comment to an issue or pull request.

### Google Calendar

See what is coming up and add events you approve.

- **Keys:** `NOVA_PLUGIN_GOOGLE_CLIENT_ID`, `NOVA_PLUGIN_GOOGLE_CLIENT_SECRET`
- **Create the app:** https://console.cloud.google.com/apis/credentials (OAuth client ID, type "Web application"). Turn on the matching API in "APIs & Services > Library".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/google_calendar` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/google_calendar`)
- **Scopes:** `openid` `email` `https://www.googleapis.com/auth/calendar.events`
- **What Nova can do:**
  - Reads: Upcoming events — Your next events on your main calendar.
  - Asks first: Add an event — Create an event. start and end are ISO date-times with a time zone offset, for example 2026-11-20T15:00:00-08:00.

### Google Drive

Find your files and save new text files you approve.

- **Keys:** `NOVA_PLUGIN_GOOGLE_CLIENT_ID`, `NOVA_PLUGIN_GOOGLE_CLIENT_SECRET`
- **Create the app:** https://console.cloud.google.com/apis/credentials (OAuth client ID, type "Web application"). Turn on the matching API in "APIs & Services > Library".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/google_drive` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/google_drive`)
- **Scopes:** `openid` `email` `https://www.googleapis.com/auth/drive.readonly` `https://www.googleapis.com/auth/drive.file`
- **What Nova can do:**
  - Reads: Find files — Search file names (leave name empty for recent files).
  - Asks first: Save a text file — Create a new plain-text file in your Drive.

### Google Docs

Read a Google Doc and create new docs you approve.

- **Keys:** `NOVA_PLUGIN_GOOGLE_CLIENT_ID`, `NOVA_PLUGIN_GOOGLE_CLIENT_SECRET`
- **Create the app:** https://console.cloud.google.com/apis/credentials (OAuth client ID, type "Web application"). Turn on the matching API in "APIs & Services > Library".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/google_docs` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/google_docs`)
- **Scopes:** `openid` `email` `https://www.googleapis.com/auth/documents`
- **What Nova can do:**
  - Reads: Read a doc — Read the text of a Google Doc by its id (the long code in the doc link).
  - Asks first: Create a doc — Create a new Google Doc with the given text.

### YouTube

Check your channel stats and uploads, and search videos.

- **Keys:** `NOVA_PLUGIN_GOOGLE_CLIENT_ID`, `NOVA_PLUGIN_GOOGLE_CLIENT_SECRET`
- **Create the app:** https://console.cloud.google.com/apis/credentials (OAuth client ID, type "Web application"). Turn on the matching API in "APIs & Services > Library".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/youtube` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/youtube`)
- **Scopes:** `openid` `email` `https://www.googleapis.com/auth/youtube.readonly`
- **What Nova can do:**
  - Reads: My channel stats — Subscribers, views and video count for your channel.
  - Reads: Search videos — Search YouTube videos.

### Notion

Search and read the Notion pages you share, and add pages you approve.

- **Keys:** `NOVA_PLUGIN_NOTION_CLIENT_ID`, `NOVA_PLUGIN_NOTION_CLIENT_SECRET`
- **Create the app:** https://www.notion.so/profile/integrations > New integration > type "Public". Add the redirect URL under "OAuth domain & URIs".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/notion` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/notion`)
- **What Nova can do:**
  - Reads: Search pages — Search the pages you shared with Nova.
  - Reads: Read a page — Read the text of a page by id.
  - Asks first: Create a page — Create a page inside a parent page you shared with Nova.

### Slack

Read your channels and post messages you approve.

- **Keys:** `NOVA_PLUGIN_SLACK_CLIENT_ID`, `NOVA_PLUGIN_SLACK_CLIENT_SECRET`
- **Create the app:** https://api.slack.com/apps > Create New App. Under "OAuth & Permissions" add the redirect URL and the User Token Scopes listed here.
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/slack` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/slack`)
- **Scopes:** `channels:read` `channels:history` `groups:read` `groups:history` `chat:write` `users:read`
- **What Nova can do:**
  - Reads: List channels — Channels you are in.
  - Reads: Read recent messages — The latest messages in a channel (use the channel id).
  - Asks first: Post a message — Post a message to a channel as you.

### Discord

See your servers, and post to the one channel you pick when connecting (after you approve).

- **Keys:** `NOVA_PLUGIN_DISCORD_CLIENT_ID`, `NOVA_PLUGIN_DISCORD_CLIENT_SECRET`
- **Create the app:** https://discord.com/developers/applications > New Application > OAuth2. Add the redirect URL under "Redirects".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/discord` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/discord`)
- **Scopes:** `identify` `guilds` `webhook.incoming`
- **What Nova can do:**
  - Reads: My servers — Discord servers you belong to.
  - Asks first: Post to my connected channel — Post a message to the channel you picked when you connected Discord.

### Spotify

See what you are playing and your top tracks, and build playlists you approve.

- **Keys:** `NOVA_PLUGIN_SPOTIFY_CLIENT_ID`, `NOVA_PLUGIN_SPOTIFY_CLIENT_SECRET`
- **Create the app:** https://developer.spotify.com/dashboard > Create app. Add the redirect URL under "Redirect URIs" and tick "Web API".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/spotify` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/spotify`)
- **Scopes:** `user-read-currently-playing` `user-top-read` `playlist-read-private` `playlist-modify-private` `playlist-modify-public`
- **What Nova can do:**
  - Reads: Now playing — The track playing right now.
  - Reads: My top tracks — Your most played tracks lately.
  - Reads: Search tracks — Search Spotify tracks (returns track URIs you can add to a playlist).
  - Asks first: Create a playlist — Create a private playlist, optionally with tracks (Spotify track URIs, comma separated).

### Dropbox

Browse and search your Dropbox, and save text files you approve.

- **Keys:** `NOVA_PLUGIN_DROPBOX_CLIENT_ID`, `NOVA_PLUGIN_DROPBOX_CLIENT_SECRET`
- **Create the app:** https://www.dropbox.com/developers/apps > Create app (Scoped access, Full Dropbox or App folder). Add the redirect URL and tick the scopes listed here under "Permissions".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/dropbox` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/dropbox`)
- **Scopes:** `account_info.read` `files.metadata.read` `files.content.read` `files.content.write`
- **What Nova can do:**
  - Reads: List a folder — List files in a folder ("" for the top level).
  - Reads: Search files — Search your Dropbox by name.
  - Asks first: Save a text file — Upload a new text file (never overwrites; a new name is picked if it exists).

### Todoist

See today's tasks and add or complete tasks you approve.

- **Keys:** `NOVA_PLUGIN_TODOIST_CLIENT_ID`, `NOVA_PLUGIN_TODOIST_CLIENT_SECRET`
- **Create the app:** https://developer.todoist.com/appconsole.html > Create a new app. Set "OAuth redirect URL" to the redirect URL.
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/todoist` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/todoist`)
- **Scopes:** `data:read_write`
- **What Nova can do:**
  - Reads: Today's tasks — Tasks due today or overdue.
  - Asks first: Add a task — Add a task to your inbox. due is plain words like "tomorrow 5pm".
  - Asks first: Complete a task — Mark a task done by id.

### Shopify

See recent orders and products in your shop, and add draft products you approve.

- **Keys:** `NOVA_PLUGIN_SHOPIFY_CLIENT_ID`, `NOVA_PLUGIN_SHOPIFY_CLIENT_SECRET`
- **Create the app:** https://partners.shopify.com > Apps > Create app (or the Dev Dashboard). Add the redirect URL under "Allowed redirection URL(s)".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/shopify` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/shopify`)
- **Scopes:** `read_orders` `read_products` `write_products`
- **What Nova can do:**
  - Reads: Recent orders — Your latest orders.
  - Reads: Products — Products in your shop.
  - Asks first: Add a draft product — Create a product as a draft (not visible to shoppers until you publish it in Shopify).

### X (Twitter)

See your profile and recent posts, and post updates you approve.

- **Keys:** `NOVA_PLUGIN_X_CLIENT_ID`, `NOVA_PLUGIN_X_CLIENT_SECRET`
- **Create the app:** https://developer.x.com/en/portal/dashboard > your app > "User authentication settings": OAuth 2.0, type "Web App", add the redirect URL as a Callback URI.
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/x` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/x`)
- **Scopes:** `tweet.read` `users.read` `tweet.write` `offline.access`
- **What Nova can do:**
  - Reads: My recent posts — Your latest posts.
  - Asks first: Post an update — Publish a post on X as you.

### Reddit

Read what is hot in a community, and submit text posts you approve.

- **Keys:** `NOVA_PLUGIN_REDDIT_CLIENT_ID`, `NOVA_PLUGIN_REDDIT_CLIENT_SECRET`
- **Create the app:** https://www.reddit.com/prefs/apps > "create another app…", type "web app". Put the redirect URL in "redirect uri".
- **Redirect URL:** `<NOVA_PLUGINS_BASE_URL>/api/nova/plugins/oauth/callback/reddit` (for example `https://llyverse.org/api/nova/plugins/oauth/callback/reddit`)
- **Scopes:** `identity` `read` `submit`
- **What Nova can do:**
  - Reads: Hot posts — Top posts right now in a subreddit (name without r/).
  - Asks first: Submit a text post — Post a text post to a subreddit as you.

### Weather

Current weather and the next few days for any city.

- **Keys:** `NOVA_PLUGIN_OPENWEATHER_API_KEY`
- **Get the key:** https://home.openweathermap.org/api_keys (free plan works).
- **What Nova can do:**
  - Reads: Current weather — Weather now in a city (for example "Angels Camp,US").
  - Reads: Forecast — The next few days in 3-hour steps (summarized by day).

### Wikipedia

Look things up on Wikipedia.

- **Keys:** none (always on)
- **What Nova can do:**
  - Reads: Search Wikipedia — Find articles.
  - Reads: Article summary — Short summary of one article by its exact title.

### Stripe (owner) (owner only)

Read-only look at the LLYVerse balance, payments and subscriptions. Nova can never charge, refund or move money.

- **Keys:** `NOVA_PLUGIN_STRIPE_READ_KEY`
- **Get the key:** https://dashboard.stripe.com/apikeys > "Create restricted key" with READ access only to Balance, Charges and Subscriptions.
- **What Nova can do:**
  - Reads: Balance — Available and pending balance.
  - Reads: Recent payments — The latest 10 charges.
  - Reads: Active subscriptions — How many active subscriptions there are (latest 100).

### Cloudflare (owner) (owner only)

Read-only look at the LLYVerse domains and DNS records.

- **Keys:** `NOVA_PLUGIN_CLOUDFLARE_READ_TOKEN`
- **Get the key:** https://dash.cloudflare.com/profile/api-tokens > Create Token with "Zone: Read" and "DNS: Read" only.
- **What Nova can do:**
  - Reads: Domains — Domains (zones) on the account.
  - Reads: DNS records — DNS records for one zone id.
