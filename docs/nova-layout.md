# Nova layout v3 (simpler menus)

Nova's new layout puts every feature under five menus:

- **Chats**
- **Workspace**
- **Explore**
- **Settings**
- **Admin** (owner only)

All three ways of getting around use the same menu config, `services/nova_menu.js`: the desktop sidebar, the phone bottom bar with its sheets, and ⌘K search. The Admin group is left out on the server for everyone except the owner, so it isn't just hidden with CSS.

## Who sees which layout

The rules are checked in this order:

1. `?ui=v2` in the address always shows the old layout.
2. `?ui=v3` shows the new layout, but only for the owner. This lets her preview it even when the kill switch is on.
3. If `.env` has `NOVA_UI_V3=false`, everyone gets the old layout. This is the kill switch: set it and restart.
4. If a member has chosen **Settings > Switch back to the old layout**, they keep the old layout. Their choice is saved per member.
5. Everyone else gets the **new layout**. This is the default and needs no setting.

## Stop Nova

**Stop Nova** pauses Nova for everyone, so only the owner/admin can press it. That applies both to the button in the menu and to the API (`POST /api/nova/stop`). Members can still cancel their own reply with the Cancel/Stop button next to the chat.
