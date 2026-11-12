/*
 * Copyright (c) 2026 LLYVerse — https://llyverse.org
 * Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
 */
/**
 * Nova plugin registry: one manifest per outside service.
 *
 * auth.type:
 *   'oauth2'     a member connects their OWN account. Enabled only when the
 *                client ID and secret env vars are set.
 *   'server_key' the site uses one API key from .env (no member account).
 *                Enabled only when that env var is set.
 *   'none'       public API that needs no key.
 *
 * action.kind:
 *   'read'  runs right away.
 *   'write' anything that sends, posts, creates, changes or deletes. It NEVER runs
 *           until the member presses Confirm on the approval card in chat
 *           (see services/nova_plugins/index.js).
 *
 * ownerOnly plugins are only listed for, and only run for, the site owner.
 */

const GOOGLE = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  clientIdEnv: 'NOVA_PLUGIN_GOOGLE_CLIENT_ID',
  clientSecretEnv: 'NOVA_PLUGIN_GOOGLE_CLIENT_SECRET',
  extraAuthorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  devConsole: 'https://console.cloud.google.com/apis/credentials (OAuth client ID, type "Web application"). Turn on the matching API in "APIs & Services > Library".'
};

const enc = encodeURIComponent;

function clip(str, n = 300) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function list(items, fn, empty = 'Nothing found.') {
  if (!Array.isArray(items) || items.length === 0) return empty;
  return items.map(fn).join('\n');
}

function b64url(str) {
  return Buffer.from(String(str), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function headerSafe(str) {
  // Block header injection in email fields.
  return String(str || '').replace(/[\r\n]+/g, ' ').trim();
}

function buildRawEmail({ to, subject, body }) {
  return b64url([
    `To: ${headerSafe(to)}`,
    `Subject: ${headerSafe(subject)}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    String(body || '')
  ].join('\r\n'));
}

function gmailHeader(msg, name) {
  const h = ((msg.payload && msg.payload.headers) || []).find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function gmailBodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const t = gmailBodyText(part);
    if (t) return t;
  }
  return '';
}

function docsText(doc) {
  const out = [];
  for (const el of ((doc.body && doc.body.content) || [])) {
    if (!el.paragraph) continue;
    for (const pe of el.paragraph.elements || []) {
      if (pe.textRun && pe.textRun.content) out.push(pe.textRun.content);
    }
  }
  return out.join('');
}

function notionTitle(obj) {
  const props = obj.properties || {};
  for (const v of Object.values(props)) {
    if (v && v.type === 'title' && Array.isArray(v.title)) return v.title.map(t => t.plain_text).join('');
  }
  if (Array.isArray(obj.title)) return obj.title.map(t => t.plain_text).join('');
  return '(untitled)';
}

// owner/name; '.' and '..' are refused so a repo can't point at another API path
const REPO_RE = /^(?!\.\.?\/)[A-Za-z0-9_.-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;

const PLUGINS = [
  // ------------------------------------------------------------------ Gmail
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Email',
    description: 'Search and read your email, draft replies, and send mail you approve.',
    auth: { type: 'oauth2', ...GOOGLE, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'] },
    actions: [
      {
        id: 'search', kind: 'read', title: 'Search email',
        description: 'Find recent emails. query uses Gmail search syntax (for example "from:shop is:unread").',
        params: { query: { type: 'string', max: 200 }, limit: { type: 'number', max: 10 } },
        async run(ctx, p) {
          const q = p.query ? `&q=${enc(p.query)}` : '';
          const listRes = await ctx.http(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${p.limit || 5}${q}`);
          const out = [];
          for (const m of (listRes.messages || []).slice(0, p.limit || 5)) {
            const full = await ctx.http(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${enc(m.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
            out.push({ id: m.id, from: gmailHeader(full, 'From'), subject: gmailHeader(full, 'Subject'), date: gmailHeader(full, 'Date'), snippet: full.snippet });
          }
          return out;
        },
        format: r => list(r, m => `- **${clip(m.subject, 120) || '(no subject)'}** from ${clip(m.from, 80)} (${clip(m.date, 40)}) [id ${m.id}]\n  ${clip(m.snippet, 160)}`, 'No matching emails.')
      },
      {
        id: 'read', kind: 'read', title: 'Read an email',
        description: 'Open one email by id (from a search).',
        params: { id: { type: 'string', required: true, max: 64 } },
        async run(ctx, p) {
          const m = await ctx.http(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${enc(p.id)}?format=full`);
          return { from: gmailHeader(m, 'From'), subject: gmailHeader(m, 'Subject'), date: gmailHeader(m, 'Date'), text: clip(gmailBodyText(m.payload) || m.snippet, 3000) };
        },
        format: r => `**${r.subject || '(no subject)'}**\nFrom: ${r.from}\nDate: ${r.date}\n\n${r.text}`
      },
      {
        id: 'create_draft', kind: 'write', title: 'Save a draft',
        description: 'Save an email draft in your Gmail (not sent).',
        params: { to: { type: 'string', required: true, max: 320 }, subject: { type: 'string', required: true, max: 200 }, body: { type: 'string', required: true, max: 8000 } },
        preview: p => `Save a Gmail draft (it will NOT be sent)\nTo: ${p.to}\nSubject: ${p.subject}\n\n${p.body}`,
        async run(ctx, p) {
          const r = await ctx.http('https://gmail.googleapis.com/gmail/v1/users/me/drafts', { method: 'POST', json: { message: { raw: buildRawEmail(p) } } });
          return { draftId: r.id };
        },
        format: r => `Draft saved in Gmail (id ${r.draftId}).`
      },
      {
        id: 'send', kind: 'write', title: 'Send an email',
        description: 'Send an email from your Gmail.',
        params: { to: { type: 'string', required: true, max: 320 }, subject: { type: 'string', required: true, max: 200 }, body: { type: 'string', required: true, max: 8000 } },
        preview: p => `SEND this email from your Gmail\nTo: ${p.to}\nSubject: ${p.subject}\n\n${p.body}`,
        async run(ctx, p) {
          const r = await ctx.http('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', json: { raw: buildRawEmail(p) } });
          return { messageId: r.id };
        },
        format: r => `Email sent (id ${r.messageId}).`
      }
    ]
  },

  // ----------------------------------------------------------------- GitHub
  {
    id: 'github',
    name: 'GitHub',
    category: 'Code',
    description: 'See your repositories and issues, and open issues or comments you approve.',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientIdEnv: 'NOVA_PLUGIN_GITHUB_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_GITHUB_CLIENT_SECRET',
      scopes: ['read:user', 'repo'],
      scopeSeparator: ' ',
      githubRevoke: true,
      devConsole: 'https://github.com/settings/developers > OAuth Apps > New OAuth App. Put the redirect URL in "Authorization callback URL".'
    },
    apiHeaders: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    actions: [
      {
        id: 'list_repos', kind: 'read', title: 'List my repositories',
        description: 'Your most recently updated repositories.',
        params: { limit: { type: 'number', max: 30 } },
        run: (ctx, p) => ctx.http(`https://api.github.com/user/repos?sort=updated&per_page=${p.limit || 10}`),
        format: r => list(r, x => `- **${x.full_name}**${x.private ? ' (private)' : ''}: ${clip(x.description || '', 120)} (${x.open_issues_count} open issues)`)
      },
      {
        id: 'list_issues', kind: 'read', title: 'List open issues',
        description: 'Open issues in one repository (owner/name).',
        params: { repo: { type: 'string', required: true, max: 140, pattern: REPO_RE } },
        run: (ctx, p) => ctx.http(`https://api.github.com/repos/${p.repo}/issues?state=open&per_page=15`),
        format: r => list(r, x => `- #${x.number} ${clip(x.title, 140)}${x.pull_request ? ' (PR)' : ''}`, 'No open issues.')
      },
      {
        id: 'create_issue', kind: 'write', title: 'Open an issue',
        description: 'Create a new issue in a repository you can write to.',
        params: { repo: { type: 'string', required: true, max: 140, pattern: REPO_RE }, title: { type: 'string', required: true, max: 250 }, body: { type: 'string', max: 8000 } },
        preview: p => `Open a GitHub issue in ${p.repo}\nTitle: ${p.title}\n\n${p.body || ''}`,
        run: (ctx, p) => ctx.http(`https://api.github.com/repos/${p.repo}/issues`, { method: 'POST', json: { title: p.title, body: p.body || '' } }),
        format: r => `Issue #${r.number} opened: ${r.html_url}`
      },
      {
        id: 'comment_issue', kind: 'write', title: 'Comment on an issue',
        description: 'Add a comment to an issue or pull request.',
        params: { repo: { type: 'string', required: true, max: 140, pattern: REPO_RE }, number: { type: 'number', required: true, max: 10000000 }, body: { type: 'string', required: true, max: 8000 } },
        preview: p => `Comment on ${p.repo}#${p.number}\n\n${p.body}`,
        run: (ctx, p) => ctx.http(`https://api.github.com/repos/${p.repo}/issues/${p.number}/comments`, { method: 'POST', json: { body: p.body } }),
        format: r => `Comment posted: ${r.html_url}`
      }
    ]
  },

  // -------------------------------------------------------- Google Calendar
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    category: 'Productivity',
    description: 'See what is coming up and add events you approve.',
    auth: { type: 'oauth2', ...GOOGLE, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'] },
    actions: [
      {
        id: 'upcoming', kind: 'read', title: 'Upcoming events',
        description: 'Your next events on your main calendar.',
        params: { limit: { type: 'number', max: 25 } },
        run: (ctx, p) => ctx.http(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=${p.limit || 10}&timeMin=${enc(new Date().toISOString())}`),
        format: r => list(r.items, e => `- **${clip(e.summary || '(no title)', 120)}**: ${(e.start && (e.start.dateTime || e.start.date)) || ''}`, 'Nothing on your calendar.')
      },
      {
        id: 'create_event', kind: 'write', title: 'Add an event',
        description: 'Create an event. start and end are ISO date-times with a time zone offset, for example 2026-11-20T15:00:00-08:00.',
        params: { title: { type: 'string', required: true, max: 200 }, start: { type: 'string', required: true, max: 40 }, end: { type: 'string', required: true, max: 40 }, description: { type: 'string', max: 4000 } },
        preview: p => `Add to your Google Calendar\n${p.title}\nFrom ${p.start} to ${p.end}\n${p.description || ''}`,
        run: (ctx, p) => ctx.http('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', json: { summary: p.title, description: p.description || '', start: { dateTime: p.start }, end: { dateTime: p.end } } }),
        format: r => `Event added: ${r.htmlLink || r.id}`
      }
    ]
  },

  // ----------------------------------------------------------- Google Drive
  {
    id: 'google_drive',
    name: 'Google Drive',
    category: 'Files',
    description: 'Find your files and save new text files you approve.',
    auth: { type: 'oauth2', ...GOOGLE, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'] },
    actions: [
      {
        id: 'search', kind: 'read', title: 'Find files',
        description: 'Search file names (leave name empty for recent files).',
        params: { name: { type: 'string', max: 120 } },
        run(ctx, p) {
          const q = p.name ? `name contains '${String(p.name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed=false` : 'trashed=false';
          return ctx.http(`https://www.googleapis.com/drive/v3/files?pageSize=10&orderBy=modifiedTime desc&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${enc(q)}`);
        },
        format: r => list(r.files, f => `- [${clip(f.name, 120)}](${f.webViewLink}) (${f.mimeType.replace('application/vnd.google-apps.', 'Google ')})`, 'No files found.')
      },
      {
        id: 'create_text_file', kind: 'write', title: 'Save a text file',
        description: 'Create a new plain-text file in your Drive.',
        params: { name: { type: 'string', required: true, max: 120 }, content: { type: 'string', required: true, max: 50000 } },
        preview: p => `Create "${p.name}" in your Google Drive (${String(p.content).length} characters)`,
        run(ctx, p) {
          const boundary = `nova${Date.now()}`;
          const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: p.name, mimeType: 'text/plain' })}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${p.content}\r\n--${boundary}--`;
          return ctx.http('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', { method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } });
        },
        format: r => `Saved to Drive: ${r.webViewLink || r.name}`
      }
    ]
  },

  // ------------------------------------------------------------ Google Docs
  {
    id: 'google_docs',
    name: 'Google Docs',
    category: 'Files',
    description: 'Read a Google Doc and create new docs you approve.',
    auth: { type: 'oauth2', ...GOOGLE, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/documents'] },
    actions: [
      {
        id: 'read', kind: 'read', title: 'Read a doc',
        description: 'Read the text of a Google Doc by its id (the long code in the doc link).',
        params: { documentId: { type: 'string', required: true, max: 120, pattern: /^[A-Za-z0-9_-]+$/ } },
        async run(ctx, p) {
          const d = await ctx.http(`https://docs.googleapis.com/v1/documents/${enc(p.documentId)}`);
          return { title: d.title, text: clip(docsText(d), 6000) };
        },
        format: r => `**${r.title}**\n\n${r.text}`
      },
      {
        id: 'create_doc', kind: 'write', title: 'Create a doc',
        description: 'Create a new Google Doc with the given text.',
        params: { title: { type: 'string', required: true, max: 200 }, text: { type: 'string', required: true, max: 50000 } },
        preview: p => `Create a Google Doc titled "${p.title}" (${String(p.text).length} characters)`,
        async run(ctx, p) {
          const d = await ctx.http('https://docs.googleapis.com/v1/documents', { method: 'POST', json: { title: p.title } });
          await ctx.http(`https://docs.googleapis.com/v1/documents/${enc(d.documentId)}:batchUpdate`, { method: 'POST', json: { requests: [{ insertText: { location: { index: 1 }, text: p.text } }] } });
          return { url: `https://docs.google.com/document/d/${d.documentId}/edit` };
        },
        format: r => `Doc created: ${r.url}`
      }
    ]
  },

  // ---------------------------------------------------------------- YouTube
  {
    id: 'youtube',
    name: 'YouTube',
    category: 'Media',
    description: 'Check your channel stats and uploads, and search videos.',
    auth: { type: 'oauth2', ...GOOGLE, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/youtube.readonly'] },
    actions: [
      {
        id: 'my_channel', kind: 'read', title: 'My channel stats',
        description: 'Subscribers, views and video count for your channel.',
        params: {},
        run: ctx => ctx.http('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true'),
        format: r => list(r.items, c => `- **${c.snippet.title}**: ${c.statistics.subscriberCount} subscribers, ${c.statistics.viewCount} views, ${c.statistics.videoCount} videos`, 'No channel on this account.')
      },
      {
        id: 'search', kind: 'read', title: 'Search videos',
        description: 'Search YouTube videos.',
        params: { query: { type: 'string', required: true, max: 200 } },
        run: (ctx, p) => ctx.http(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${enc(p.query)}`),
        format: r => list(r.items, v => `- [${clip(v.snippet.title, 120)}](https://www.youtube.com/watch?v=${v.id.videoId}) by ${v.snippet.channelTitle}`)
      }
    ]
  },

  // ----------------------------------------------------------------- Notion
  {
    id: 'notion',
    name: 'Notion',
    category: 'Productivity',
    description: 'Search and read the Notion pages you share, and add pages you approve.',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
      tokenUrl: 'https://api.notion.com/v1/oauth/token',
      clientIdEnv: 'NOVA_PLUGIN_NOTION_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_NOTION_CLIENT_SECRET',
      scopes: [],
      extraAuthorizeParams: { owner: 'user' },
      tokenAuth: 'basic',
      tokenBodyJson: true,
      devConsole: 'https://www.notion.so/profile/integrations > New integration > type "Public". Add the redirect URL under "OAuth domain & URIs".'
    },
    apiHeaders: { 'Notion-Version': '2022-06-28' },
    actions: [
      {
        id: 'search', kind: 'read', title: 'Search pages',
        description: 'Search the pages you shared with Nova.',
        params: { query: { type: 'string', max: 200 } },
        run: (ctx, p) => ctx.http('https://api.notion.com/v1/search', { method: 'POST', json: { query: p.query || '', page_size: 10 } }),
        format: r => list(r.results, x => `- [${clip(notionTitle(x), 120)}](${x.url}) [id ${x.id}]`, 'No pages found. Share pages with the LLYVerse integration in Notion first.')
      },
      {
        id: 'read_page', kind: 'read', title: 'Read a page',
        description: 'Read the text of a page by id.',
        params: { pageId: { type: 'string', required: true, max: 64, pattern: /^[A-Za-z0-9-]+$/ } },
        async run(ctx, p) {
          const r = await ctx.http(`https://api.notion.com/v1/blocks/${enc(p.pageId)}/children?page_size=100`);
          const lines = [];
          for (const b of r.results || []) {
            const rich = (b[b.type] && b[b.type].rich_text) || [];
            const text = rich.map(t => t.plain_text).join('');
            if (text) lines.push(text);
          }
          return { text: clip(lines.join('\n'), 6000) };
        },
        format: r => r.text || '(This page has no text.)'
      },
      {
        id: 'create_page', kind: 'write', title: 'Create a page',
        description: 'Create a page inside a parent page you shared with Nova.',
        params: { parentPageId: { type: 'string', required: true, max: 64, pattern: /^[A-Za-z0-9-]+$/ }, title: { type: 'string', required: true, max: 200 }, text: { type: 'string', max: 2000 } },
        preview: p => `Create a Notion page "${p.title}" under page ${p.parentPageId}\n\n${p.text || ''}`,
        run: (ctx, p) => ctx.http('https://api.notion.com/v1/pages', {
          method: 'POST',
          json: {
            parent: { page_id: p.parentPageId },
            properties: { title: { title: [{ text: { content: p.title } }] } },
            children: p.text ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.text } }] } }] : []
          }
        }),
        format: r => `Page created: ${r.url}`
      }
    ]
  },

  // ------------------------------------------------------------------ Slack
  {
    id: 'slack',
    name: 'Slack',
    category: 'Messaging',
    description: 'Read your channels and post messages you approve.',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
      revokeUrl: 'https://slack.com/api/auth.revoke',
      clientIdEnv: 'NOVA_PLUGIN_SLACK_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_SLACK_CLIENT_SECRET',
      scopes: ['channels:read', 'channels:history', 'groups:read', 'groups:history', 'chat:write', 'users:read'],
      scopeParam: 'user_scope',
      scopeSeparator: ',',
      tokenPath: 'authed_user',
      devConsole: 'https://api.slack.com/apps > Create New App. Under "OAuth & Permissions" add the redirect URL and the User Token Scopes listed here.'
    },
    actions: [
      {
        id: 'list_channels', kind: 'read', title: 'List channels',
        description: 'Channels you are in.',
        params: {},
        run: ctx => ctx.http('https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=100', { slack: true }),
        format: r => list(r.channels, c => `- #${c.name} [id ${c.id}]`)
      },
      {
        id: 'read_channel', kind: 'read', title: 'Read recent messages',
        description: 'The latest messages in a channel (use the channel id).',
        params: { channel: { type: 'string', required: true, max: 32, pattern: /^[A-Z0-9]+$/ } },
        run: (ctx, p) => ctx.http(`https://slack.com/api/conversations.history?channel=${enc(p.channel)}&limit=15`, { slack: true }),
        format: r => list(r.messages, m => `- ${clip(m.text, 240)}`, 'No messages.')
      },
      {
        id: 'post_message', kind: 'write', title: 'Post a message',
        description: 'Post a message to a channel as you.',
        params: { channel: { type: 'string', required: true, max: 32, pattern: /^[A-Z0-9]+$/ }, text: { type: 'string', required: true, max: 4000 } },
        preview: p => `Post to Slack channel ${p.channel} as you:\n\n${p.text}`,
        run: (ctx, p) => ctx.http('https://slack.com/api/chat.postMessage', { method: 'POST', json: { channel: p.channel, text: p.text }, slack: true }),
        format: () => 'Posted to Slack.'
      }
    ]
  },

  // ---------------------------------------------------------------- Discord
  {
    id: 'discord',
    name: 'Discord',
    category: 'Messaging',
    description: 'See your servers, and post to the one channel you pick when connecting (after you approve).',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://discord.com/oauth2/authorize',
      tokenUrl: 'https://discord.com/api/oauth2/token',
      revokeUrl: 'https://discord.com/api/oauth2/token/revoke',
      clientIdEnv: 'NOVA_PLUGIN_DISCORD_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_DISCORD_CLIENT_SECRET',
      scopes: ['identify', 'guilds', 'webhook.incoming'],
      scopeSeparator: ' ',
      keepFromToken: ['webhook'],
      devConsole: 'https://discord.com/developers/applications > New Application > OAuth2. Add the redirect URL under "Redirects".'
    },
    actions: [
      {
        id: 'my_servers', kind: 'read', title: 'My servers',
        description: 'Discord servers you belong to.',
        params: {},
        run: ctx => ctx.http('https://discord.com/api/users/@me/guilds'),
        format: r => list(r, g => `- ${g.name}`)
      },
      {
        id: 'post_to_channel', kind: 'write', title: 'Post to my connected channel',
        description: 'Post a message to the channel you picked when you connected Discord.',
        params: { text: { type: 'string', required: true, max: 2000 } },
        preview: (p, account) => `Post to Discord${account && account.webhook && account.webhook.name ? ` as "${account.webhook.name}"` : ''} in your connected channel:\n\n${p.text}`,
        async run(ctx, p) {
          const hook = ctx.account && ctx.account.webhook;
          if (!hook || !hook.id || !hook.token) throw new Error('No Discord channel was picked when you connected. Disconnect and connect again to pick one.');
          await ctx.http(`https://discord.com/api/webhooks/${enc(hook.id)}/${enc(hook.token)}`, { method: 'POST', json: { content: p.text, allowed_mentions: { parse: [] } }, noAuth: true });
          return { ok: true };
        },
        format: () => 'Posted to Discord.'
      }
    ]
  },

  // ---------------------------------------------------------------- Spotify
  {
    id: 'spotify',
    name: 'Spotify',
    category: 'Music',
    description: 'See what you are playing and your top tracks, and build playlists you approve.',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://accounts.spotify.com/authorize',
      tokenUrl: 'https://accounts.spotify.com/api/token',
      clientIdEnv: 'NOVA_PLUGIN_SPOTIFY_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_SPOTIFY_CLIENT_SECRET',
      scopes: ['user-read-currently-playing', 'user-top-read', 'playlist-read-private', 'playlist-modify-private', 'playlist-modify-public'],
      scopeSeparator: ' ',
      tokenAuth: 'basic',
      devConsole: 'https://developer.spotify.com/dashboard > Create app. Add the redirect URL under "Redirect URIs" and tick "Web API".'
    },
    actions: [
      {
        id: 'now_playing', kind: 'read', title: 'Now playing',
        description: 'The track playing right now.',
        params: {},
        run: ctx => ctx.http('https://api.spotify.com/v1/me/player/currently-playing'),
        format: r => (r && r.item) ? `Now playing: **${r.item.name}** by ${(r.item.artists || []).map(a => a.name).join(', ')}` : 'Nothing is playing right now.'
      },
      {
        id: 'top_tracks', kind: 'read', title: 'My top tracks',
        description: 'Your most played tracks lately.',
        params: {},
        run: ctx => ctx.http('https://api.spotify.com/v1/me/top/tracks?limit=10&time_range=short_term'),
        format: r => list(r.items, t => `- **${t.name}** by ${(t.artists || []).map(a => a.name).join(', ')}`)
      },
      {
        id: 'search_tracks', kind: 'read', title: 'Search tracks',
        description: 'Search Spotify tracks (returns track URIs you can add to a playlist).',
        params: { query: { type: 'string', required: true, max: 200 } },
        run: (ctx, p) => ctx.http(`https://api.spotify.com/v1/search?type=track&limit=5&q=${enc(p.query)}`),
        format: r => list(r.tracks && r.tracks.items, t => `- **${t.name}** by ${(t.artists || []).map(a => a.name).join(', ')} [${t.uri}]`)
      },
      {
        id: 'create_playlist', kind: 'write', title: 'Create a playlist',
        description: 'Create a private playlist, optionally with tracks (Spotify track URIs, comma separated).',
        params: { name: { type: 'string', required: true, max: 100 }, description: { type: 'string', max: 300 }, trackUris: { type: 'string', max: 4000 } },
        preview: p => `Create a private Spotify playlist "${p.name}"${p.trackUris ? ` with ${String(p.trackUris).split(',').filter(Boolean).length} tracks` : ''}`,
        async run(ctx, p) {
          const me = await ctx.http('https://api.spotify.com/v1/me');
          const pl = await ctx.http(`https://api.spotify.com/v1/users/${enc(me.id)}/playlists`, { method: 'POST', json: { name: p.name, description: p.description || '', public: false } });
          const uris = String(p.trackUris || '').split(',').map(s => s.trim()).filter(u => /^spotify:track:[A-Za-z0-9]+$/.test(u)).slice(0, 100);
          if (uris.length) await ctx.http(`https://api.spotify.com/v1/playlists/${enc(pl.id)}/tracks`, { method: 'POST', json: { uris } });
          return { url: pl.external_urls && pl.external_urls.spotify, added: uris.length };
        },
        format: r => `Playlist created with ${r.added} tracks: ${r.url}`
      }
    ]
  },

  // ---------------------------------------------------------------- Dropbox
  {
    id: 'dropbox',
    name: 'Dropbox',
    category: 'Files',
    description: 'Browse and search your Dropbox, and save text files you approve.',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      clientIdEnv: 'NOVA_PLUGIN_DROPBOX_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_DROPBOX_CLIENT_SECRET',
      scopes: ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write'],
      scopeSeparator: ' ',
      extraAuthorizeParams: { token_access_type: 'offline' },
      dropboxRevoke: true,
      devConsole: 'https://www.dropbox.com/developers/apps > Create app (Scoped access, Full Dropbox or App folder). Add the redirect URL and tick the scopes listed here under "Permissions".'
    },
    actions: [
      {
        id: 'list_folder', kind: 'read', title: 'List a folder',
        description: 'List files in a folder ("" for the top level).',
        params: { path: { type: 'string', max: 400 } },
        run: (ctx, p) => ctx.http('https://api.dropboxapi.com/2/files/list_folder', { method: 'POST', json: { path: p.path ? (String(p.path).startsWith('/') ? p.path : `/${p.path}`) : '', limit: 25 } }),
        format: r => list(r.entries, e => `- ${e['.tag'] === 'folder' ? '📁' : '📄'} ${e.path_display}`, 'This folder is empty.')
      },
      {
        id: 'search', kind: 'read', title: 'Search files',
        description: 'Search your Dropbox by name.',
        params: { query: { type: 'string', required: true, max: 200 } },
        run: (ctx, p) => ctx.http('https://api.dropboxapi.com/2/files/search_v2', { method: 'POST', json: { query: p.query, options: { max_results: 10 } } }),
        format: r => list(r.matches, m => `- ${m.metadata && m.metadata.metadata ? m.metadata.metadata.path_display : '(file)'}`)
      },
      {
        id: 'save_text_file', kind: 'write', title: 'Save a text file',
        description: 'Upload a new text file (never overwrites; a new name is picked if it exists).',
        params: { path: { type: 'string', required: true, max: 400 }, content: { type: 'string', required: true, max: 50000 } },
        preview: p => `Save a new file to your Dropbox at ${p.path} (${String(p.content).length} characters)`,
        run: (ctx, p) => ctx.http('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          body: Buffer.from(String(p.content), 'utf8'),
          headers: {
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ path: String(p.path).startsWith('/') ? p.path : `/${p.path}`, mode: 'add', autorename: true }).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
          }
        }),
        format: r => `Saved to Dropbox: ${r.path_display}`
      }
    ]
  },

  // ---------------------------------------------------------------- Todoist
  {
    id: 'todoist',
    name: 'Todoist',
    category: 'Productivity',
    description: 'See today\'s tasks and add or complete tasks you approve.',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://todoist.com/oauth/authorize',
      tokenUrl: 'https://todoist.com/oauth/access_token',
      clientIdEnv: 'NOVA_PLUGIN_TODOIST_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_TODOIST_CLIENT_SECRET',
      scopes: ['data:read_write'],
      scopeSeparator: ',',
      devConsole: 'https://developer.todoist.com/appconsole.html > Create a new app. Set "OAuth redirect URL" to the redirect URL.'
    },
    actions: [
      {
        id: 'today', kind: 'read', title: 'Today\'s tasks',
        description: 'Tasks due today or overdue.',
        params: {},
        run: ctx => ctx.http(`https://api.todoist.com/api/v1/tasks/filter?query=${enc('today | overdue')}&limit=50`),
        format: r => list(Array.isArray(r) ? r : r.results, t => `- ${clip(t.content, 200)} [id ${t.id}]`, 'Nothing due today.')
      },
      {
        id: 'add_task', kind: 'write', title: 'Add a task',
        description: 'Add a task to your inbox. due is plain words like "tomorrow 5pm".',
        params: { content: { type: 'string', required: true, max: 500 }, due: { type: 'string', max: 100 } },
        preview: p => `Add a Todoist task: "${p.content}"${p.due ? ` due ${p.due}` : ''}`,
        run: (ctx, p) => ctx.http('https://api.todoist.com/api/v1/tasks', { method: 'POST', json: p.due ? { content: p.content, due_string: p.due } : { content: p.content } }),
        format: r => `Task added: ${r.content}`
      },
      {
        id: 'complete_task', kind: 'write', title: 'Complete a task',
        description: 'Mark a task done by id.',
        params: { id: { type: 'string', required: true, max: 64, pattern: /^[A-Za-z0-9]+$/ } },
        preview: p => `Mark Todoist task ${p.id} as done`,
        run: (ctx, p) => ctx.http(`https://api.todoist.com/api/v1/tasks/${enc(p.id)}/close`, { method: 'POST' }),
        format: () => 'Task completed.'
      }
    ]
  },

  // ---------------------------------------------------------------- Shopify
  {
    id: 'shopify',
    name: 'Shopify',
    category: 'Selling',
    description: 'See recent orders and products in your shop, and add draft products you approve.',
    auth: {
      type: 'oauth2',
      shopify: true,
      authorizeUrl: 'https://{shop}/admin/oauth/authorize',
      tokenUrl: 'https://{shop}/admin/oauth/access_token',
      clientIdEnv: 'NOVA_PLUGIN_SHOPIFY_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_SHOPIFY_CLIENT_SECRET',
      scopes: ['read_orders', 'read_products', 'write_products'],
      scopeSeparator: ',',
      tokenBodyJson: true,
      devConsole: 'https://partners.shopify.com > Apps > Create app (or the Dev Dashboard). Add the redirect URL under "Allowed redirection URL(s)".'
    },
    apiVersion: '2025-10',
    actions: [
      {
        id: 'recent_orders', kind: 'read', title: 'Recent orders',
        description: 'Your latest orders.',
        params: {},
        run: ctx => ctx.http(`https://${ctx.account.shop}/admin/api/2025-10/orders.json?status=any&limit=10`, { shopify: true }),
        format: r => list(r.orders, o => `- ${o.name}: ${o.total_price} ${o.currency} (${o.financial_status || ''}, ${o.fulfillment_status || 'unfulfilled'})`, 'No orders yet.')
      },
      {
        id: 'products', kind: 'read', title: 'Products',
        description: 'Products in your shop.',
        params: {},
        run: ctx => ctx.http(`https://${ctx.account.shop}/admin/api/2025-10/products.json?limit=20`, { shopify: true }),
        format: r => list(r.products, x => `- **${x.title}** (${x.status})`)
      },
      {
        id: 'create_draft_product', kind: 'write', title: 'Add a draft product',
        description: 'Create a product as a draft (not visible to shoppers until you publish it in Shopify).',
        params: { title: { type: 'string', required: true, max: 200 }, description: { type: 'string', max: 5000 }, price: { type: 'string', max: 12, pattern: /^\d+(\.\d{1,2})?$/ } },
        preview: (p, account) => `Add a DRAFT product to ${account && account.shop ? account.shop : 'your shop'}\nTitle: ${p.title}${p.price ? `\nPrice: ${p.price}` : ''}\n\n${p.description || ''}`,
        run: (ctx, p) => ctx.http(`https://${ctx.account.shop}/admin/api/2025-10/products.json`, {
          method: 'POST', shopify: true,
          json: { product: { title: p.title, body_html: String(p.description || '').replace(/[<>]/g, ''), status: 'draft', variants: p.price ? [{ price: p.price }] : undefined } }
        }),
        format: r => `Draft product added: ${r.product && r.product.title}`
      }
    ]
  },

  // ----------------------------------------------------------------------- X
  {
    id: 'x',
    name: 'X (Twitter)',
    category: 'Social',
    description: 'See your profile and recent posts, and post updates you approve.',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://x.com/i/oauth2/authorize',
      tokenUrl: 'https://api.x.com/2/oauth2/token',
      revokeUrl: 'https://api.x.com/2/oauth2/revoke',
      clientIdEnv: 'NOVA_PLUGIN_X_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_X_CLIENT_SECRET',
      scopes: ['tweet.read', 'users.read', 'tweet.write', 'offline.access'],
      scopeSeparator: ' ',
      pkce: true,
      tokenAuth: 'basic',
      devConsole: 'https://developer.x.com/en/portal/dashboard > your app > "User authentication settings": OAuth 2.0, type "Web App", add the redirect URL as a Callback URI.'
    },
    actions: [
      {
        id: 'my_posts', kind: 'read', title: 'My recent posts',
        description: 'Your latest posts.',
        params: {},
        async run(ctx) {
          const me = await ctx.http('https://api.x.com/2/users/me');
          const posts = await ctx.http(`https://api.x.com/2/users/${enc(me.data.id)}/tweets?max_results=5`);
          return { username: me.data.username, posts: posts.data || [] };
        },
        format: r => `@${r.username}\n${list(r.posts, t => `- ${clip(t.text, 280)}`, 'No recent posts.')}`
      },
      {
        id: 'post', kind: 'write', title: 'Post an update',
        description: 'Publish a post on X as you.',
        params: { text: { type: 'string', required: true, max: 280 } },
        preview: p => `Post this publicly on X as you:\n\n${p.text}`,
        run: (ctx, p) => ctx.http('https://api.x.com/2/tweets', { method: 'POST', json: { text: p.text } }),
        format: r => `Posted on X (id ${r.data && r.data.id}).`
      }
    ]
  },

  // ----------------------------------------------------------------- Reddit
  {
    id: 'reddit',
    name: 'Reddit',
    category: 'Social',
    description: 'Read what is hot in a community, and submit text posts you approve.',
    auth: {
      type: 'oauth2',
      authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
      tokenUrl: 'https://www.reddit.com/api/v1/access_token',
      revokeUrl: 'https://www.reddit.com/api/v1/revoke_token',
      clientIdEnv: 'NOVA_PLUGIN_REDDIT_CLIENT_ID',
      clientSecretEnv: 'NOVA_PLUGIN_REDDIT_CLIENT_SECRET',
      scopes: ['identity', 'read', 'submit'],
      scopeSeparator: ' ',
      extraAuthorizeParams: { duration: 'permanent' },
      tokenAuth: 'basic',
      devConsole: 'https://www.reddit.com/prefs/apps > "create another app…", type "web app". Put the redirect URL in "redirect uri".'
    },
    actions: [
      {
        id: 'hot', kind: 'read', title: 'Hot posts',
        description: 'Top posts right now in a subreddit (name without r/).',
        params: { subreddit: { type: 'string', required: true, max: 50, pattern: /^[A-Za-z0-9_]+$/ } },
        run: (ctx, p) => ctx.http(`https://oauth.reddit.com/r/${p.subreddit}/hot?limit=8`),
        format: r => list(r.data && r.data.children, c => `- ${clip(c.data.title, 200)} (${c.data.score} points) https://reddit.com${c.data.permalink}`)
      },
      {
        id: 'submit_text', kind: 'write', title: 'Submit a text post',
        description: 'Post a text post to a subreddit as you.',
        params: { subreddit: { type: 'string', required: true, max: 50, pattern: /^[A-Za-z0-9_]+$/ }, title: { type: 'string', required: true, max: 300 }, text: { type: 'string', max: 10000 } },
        preview: p => `Post publicly to r/${p.subreddit} as you\nTitle: ${p.title}\n\n${p.text || ''}`,
        run: (ctx, p) => ctx.http('https://oauth.reddit.com/api/submit', { method: 'POST', form: { sr: p.subreddit, kind: 'self', title: p.title, text: p.text || '', api_type: 'json' } }),
        format: r => (r.json && r.json.data && r.json.data.url) ? `Posted: ${r.json.data.url}` : 'Submitted to Reddit.'
      }
    ]
  },

  // ------------------------------------------------------------ OpenWeather
  {
    id: 'openweather',
    name: 'Weather',
    category: 'Everyday',
    description: 'Current weather and the next few days for any city.',
    auth: { type: 'server_key', keyEnv: 'NOVA_PLUGIN_OPENWEATHER_API_KEY', devConsole: 'https://home.openweathermap.org/api_keys (free plan works).' },
    actions: [
      {
        id: 'current', kind: 'read', title: 'Current weather',
        description: 'Weather now in a city (for example "Angels Camp,US").',
        params: { city: { type: 'string', required: true, max: 100 } },
        run: (ctx, p) => ctx.http(`https://api.openweathermap.org/data/2.5/weather?units=imperial&q=${enc(p.city)}&appid=${enc(ctx.key)}`, { noAuth: true }),
        format: r => `${r.name}: ${Math.round(r.main.temp)}°F (feels like ${Math.round(r.main.feels_like)}°F), ${(r.weather && r.weather[0] && r.weather[0].description) || ''}, wind ${Math.round(r.wind.speed)} mph`
      },
      {
        id: 'forecast', kind: 'read', title: 'Forecast',
        description: 'The next few days in 3-hour steps (summarized by day).',
        params: { city: { type: 'string', required: true, max: 100 } },
        run: (ctx, p) => ctx.http(`https://api.openweathermap.org/data/2.5/forecast?units=imperial&q=${enc(p.city)}&appid=${enc(ctx.key)}`, { noAuth: true }),
        format(r) {
          const days = {};
          for (const it of r.list || []) {
            const d = String(it.dt_txt).slice(0, 10);
            days[d] = days[d] || { lo: Infinity, hi: -Infinity, desc: (it.weather && it.weather[0] && it.weather[0].description) || '' };
            days[d].lo = Math.min(days[d].lo, it.main.temp_min);
            days[d].hi = Math.max(days[d].hi, it.main.temp_max);
          }
          return `${r.city ? r.city.name : ''}\n` + Object.entries(days).map(([d, v]) => `- ${d}: ${Math.round(v.lo)}–${Math.round(v.hi)}°F, ${v.desc}`).join('\n');
        }
      }
    ]
  },

  // -------------------------------------------------------------- Wikipedia
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    category: 'Everyday',
    description: 'Look things up on Wikipedia.',
    auth: { type: 'none' },
    actions: [
      {
        id: 'search', kind: 'read', title: 'Search Wikipedia',
        description: 'Find articles.',
        params: { query: { type: 'string', required: true, max: 200 } },
        run: (ctx, p) => ctx.http(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${enc(p.query)}`, { noAuth: true }),
        format: r => list(r.query && r.query.search, s => `- **${s.title}**: ${clip(String(s.snippet).replace(/<[^>]+>/g, ''), 160)}`)
      },
      {
        id: 'summary', kind: 'read', title: 'Article summary',
        description: 'Short summary of one article by its exact title.',
        params: { title: { type: 'string', required: true, max: 200 } },
        run: (ctx, p) => ctx.http(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(String(p.title).replace(/ /g, '_'))}`, { noAuth: true }),
        format: r => `**${r.title}**\n\n${r.extract}\n\n${r.content_urls && r.content_urls.desktop ? r.content_urls.desktop.page : ''}`
      }
    ]
  },

  // ------------------------------------------------- Stripe (owner, read-only)
  {
    id: 'stripe',
    name: 'Stripe (owner)',
    category: 'Owner tools',
    ownerOnly: true,
    description: 'Read-only look at the LLYVerse balance, payments and subscriptions. Nova can never charge, refund or move money.',
    auth: { type: 'server_key', keyEnv: 'NOVA_PLUGIN_STRIPE_READ_KEY', devConsole: 'https://dashboard.stripe.com/apikeys > "Create restricted key" with READ access only to Balance, Charges and Subscriptions.' },
    actions: [
      {
        id: 'balance', kind: 'read', title: 'Balance',
        description: 'Available and pending balance.',
        params: {},
        run: ctx => ctx.http('https://api.stripe.com/v1/balance', { bearer: ctx.key }),
        format: r => ['available', 'pending'].map(k => `- ${k}: ${(r[k] || []).map(b => `${(b.amount / 100).toFixed(2)} ${String(b.currency).toUpperCase()}`).join(', ') || '0'}`).join('\n')
      },
      {
        id: 'recent_payments', kind: 'read', title: 'Recent payments',
        description: 'The latest 10 charges.',
        params: {},
        run: ctx => ctx.http('https://api.stripe.com/v1/charges?limit=10', { bearer: ctx.key }),
        format: r => list(r.data, c => `- ${(c.amount / 100).toFixed(2)} ${String(c.currency).toUpperCase()} · ${c.status}${c.refunded ? ' (refunded)' : ''} · ${new Date(c.created * 1000).toISOString().slice(0, 10)}`, 'No payments yet.')
      },
      {
        id: 'active_subscriptions', kind: 'read', title: 'Active subscriptions',
        description: 'How many active subscriptions there are (latest 100).',
        params: {},
        run: ctx => ctx.http('https://api.stripe.com/v1/subscriptions?status=active&limit=100', { bearer: ctx.key }),
        format: r => `${(r.data || []).length}${r.has_more ? '+' : ''} active subscriptions.`
      }
    ]
  },

  // --------------------------------------------- Cloudflare (owner, read-only)
  {
    id: 'cloudflare',
    name: 'Cloudflare (owner)',
    category: 'Owner tools',
    ownerOnly: true,
    description: 'Read-only look at the LLYVerse domains and DNS records.',
    auth: { type: 'server_key', keyEnv: 'NOVA_PLUGIN_CLOUDFLARE_READ_TOKEN', devConsole: 'https://dash.cloudflare.com/profile/api-tokens > Create Token with "Zone: Read" and "DNS: Read" only.' },
    actions: [
      {
        id: 'zones', kind: 'read', title: 'Domains',
        description: 'Domains (zones) on the account.',
        params: {},
        run: ctx => ctx.http('https://api.cloudflare.com/client/v4/zones?per_page=50', { bearer: ctx.key }),
        format: r => list(r.result, z => `- ${z.name} (${z.status}) [id ${z.id}]`)
      },
      {
        id: 'dns_records', kind: 'read', title: 'DNS records',
        description: 'DNS records for one zone id.',
        params: { zoneId: { type: 'string', required: true, max: 40, pattern: /^[a-f0-9]{32}$/ } },
        run: (ctx, p) => ctx.http(`https://api.cloudflare.com/client/v4/zones/${p.zoneId}/dns_records?per_page=100`, { bearer: ctx.key }),
        format: r => list(r.result, d => `- ${d.type} ${d.name} → ${clip(d.content, 80)}${d.proxied ? ' (proxied)' : ''}`)
      }
    ]
  }
];

module.exports = { PLUGINS, helpers: { buildRawEmail, headerSafe, clip } };
