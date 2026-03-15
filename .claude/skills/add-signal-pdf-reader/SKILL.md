---
name: add-signal-pdf-reader
description: Add PDF reading to NanoClaw agents via Signal attachments. Extracts text from PDFs via pdftotext CLI.
---

# Signal PDF Reader

Adds PDF reading capability to container agents using poppler-utils (pdftotext/pdfinfo). PDFs sent as Signal attachments are copied from signal-cli's data directory to the group workspace.

## Phase 1: Pre-flight

1. Check if `container/skills/pdf-reader/pdf-reader` exists — skip to Phase 3 if already applied
2. Confirm Signal is installed first (`/add-signal`). This skill modifies `src/channels/signal.ts`.

## Phase 2: Apply Code Changes

### Ensure Signal fork remote

```bash
git remote -v
```

If `signal` is missing, add it:

```bash
git remote add signal https://github.com/brentkearney/nanoclaw-signal.git
```

### Merge the skill branch

```bash
git fetch signal skill/pdf-reader
git merge signal/skill/pdf-reader || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `container/skills/pdf-reader/SKILL.md` (agent-facing documentation)
- `container/skills/pdf-reader/pdf-reader` (CLI script)
- `poppler-utils` in `container/Dockerfile`
- PDF attachment copying in `src/channels/signal.ts`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate

```bash
npm run build
npx vitest run src/channels/signal.test.ts
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Test PDF extraction

Send a PDF file in a registered Signal chat. The agent should:
1. Copy the PDF from signal-cli's attachments directory to `attachments/`
2. Respond acknowledging the PDF
3. Be able to extract text when asked

### Test URL fetching

Ask the agent to read a PDF from a URL. It should use `pdf-reader fetch <url>`.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i pdf
```

Look for:
- `PDF attachment file not found` — signal-cli attachment path issue, check `~/.local/share/signal-cli/attachments/`

## Troubleshooting

### Agent says pdf-reader command not found

Container needs rebuilding. Run `./container/build.sh` and restart the service.

### PDF text extraction is empty

The PDF may be scanned (image-based). pdftotext only handles text-based PDFs. Consider using the agent-browser to open the PDF visually instead.

### Signal PDF not detected

Verify the attachment has `contentType: application/pdf`. The NanoClaw user must have read access to signal-cli's attachment directory (`~/.local/share/signal-cli/attachments/`).
