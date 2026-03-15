# Intent: src/channels/signal.ts modifications

## What changed
Added PDF attachment download and path injection. When a Signal message contains a PDF attachment, it is copied from signal-cli's data directory to the group's attachments/ folder, and a file reference with pdf-reader usage hint is injected into the message content.

## Key sections

### Imports (top of file)
- Added: `existsSync` from `node:fs`
- Added: `copyFile`, `mkdir` from `node:fs/promises`
- Added: `os` from `node:os`
- Added: `path` from `node:path`
- Added: `resolveGroupFolderPath` from `../group-folder.js`

### Constructor
- Added: `signalDataDir` parameter (last, with default `~/.local/share/signal-cli`)

### copyPdfAttachment method (new private method)
- Copies PDF from signal-cli attachments dir to group's `attachments/` folder
- Returns formatted reference: `[PDF: attachments/filename (sizeKB)]\nUse: pdf-reader extract attachments/filename`

### handleSseEvent — sync message handler (Note to Self)
- Changed guard: allow attachment-only messages (`if (!text && !(syncSent.attachments?.length)) return`)
- Added: PDF detection loop after group lookup, before onMessage call
- Changed: uses `syncContent` variable to accumulate text + PDF refs

### handleSseEvent — data message handler
- Changed guard: allow attachment-only messages (`if (!text && !(dataMessage.attachments?.length)) return`)
- Added: PDF detection loop after group lookup, before trigger detection
- Added: `if (!content) return` guard after attachment processing

### registerChannel factory
- Added: reads `SIGNAL_DATA_DIR` env var
- Added: passes `signalDataDir` to constructor

## Invariants (must-keep)
- All existing Signal functionality (daemon management, SSE streaming, echo cache, typing indicators, message chunking, reconnect logic)
- Connection lifecycle unchanged
- sendMessage prefix logic unchanged
- Trigger detection for groups unchanged
