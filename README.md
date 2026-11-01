# Nova AI (@llyverse/nova)

Nova AI package: conversational intelligence, neural computer control, MCP tooling, routines, live workstation streaming, and multimodal integration for LLYVerse.

## Overview
Nova is the resident intelligence of the LLYVerse ecosystem. This standalone package encapsulates:
- Chat service & memory retention engine (`lib/nova_chat.js`, `lib/nova_jobs.js`)
- Screen streaming & remote computer control (`lib/nova_screen.js`, `lib/nova_computer.js`)
- Model Context Protocol (MCP) server & client (`lib/nova_mcp.js`)
- UI templates and partials (`views/`, `views/partials/nova/`)
- Front-end assets (`public/js/nova/`, `public/css/`)

## Environment Variables
- `NOVA_COMPUTER_ENABLED`: Set to `true` to enable desktop screen & computer tools (founder only).
- `NOVA_UI_V3`: Feature flag enabling the v3 unified 5-group layout.

## Testing & Sanitization
```bash
npm run check:names
```

## License
LLYVerse License 1.0. See [LICENSE](LICENSE).
