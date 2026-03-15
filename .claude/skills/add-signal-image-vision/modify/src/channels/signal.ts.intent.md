# Intent: src/channels/signal.ts modifications

## What changed
Added image attachment processing. When a Signal message contains an image attachment, it is read from signal-cli's data directory, resized/processed via `processImage`, and saved to the group's attachments/ folder. An `[Image: attachments/...]` reference is injected into the message content.

## Key sections

### Imports (top of file)
- Added: `existsSync` from `node:fs`
- Added: `mkdir`, `readFile` from `node:fs/promises`
- Added: `os` from `node:os`
- Added: `path` from `node:path`
- Added: `resolveGroupFolderPath` from `../group-folder.js`
- Added: `processImage` from `../image.js`

### Constructor
- Added: `signalDataDir` parameter (last, with default `~/.local/share/signal-cli`)

### processImageAttachment method (new private method)
- Reads image buffer from signal-cli attachments dir
- Calls `processImage(buffer, groupDir, '')` to resize and save
- Returns formatted reference from processImage result

### handleSseEvent — sync message handler (Note to Self)
- Changed guard: allow attachment-only messages
- Added: image detection loop after group lookup, before onMessage call
- Changed: uses `syncContent` variable to accumulate text + image refs

### handleSseEvent — data message handler
- Changed guard: allow attachment-only messages
- Added: image detection loop after group lookup, before trigger detection
- Added: `if (!content) return` guard after attachment processing

### registerChannel factory
- Added: reads `SIGNAL_DATA_DIR` env var
- Added: passes `signalDataDir` to constructor

## Invariants (must-keep)
- All existing Signal functionality (daemon management, SSE streaming, echo cache, typing indicators, message chunking, reconnect logic)
- Connection lifecycle unchanged
- sendMessage prefix logic unchanged
- Trigger detection for groups unchanged
