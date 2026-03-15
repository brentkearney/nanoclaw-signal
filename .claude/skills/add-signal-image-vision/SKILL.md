---
name: add-signal-image-vision
description: Add image vision to NanoClaw agents via Signal image attachments. Resizes and processes images, then sends them to Claude as multimodal content blocks.
---

# Signal Image Vision Skill

Adds the ability for NanoClaw agents to see and understand images sent via Signal. Images are copied from signal-cli's attachment directory, resized with sharp, saved to the group workspace, and passed to the agent as base64-encoded multimodal content blocks.

## Phase 1: Pre-flight

1. Check if `src/image.ts` exists — skip to Phase 3 if already applied
2. Confirm `sharp` is installable (native bindings require build tools)

**Prerequisite:** Signal must be installed first (`/add-signal`). This skill modifies `src/channels/signal.ts`.

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
git fetch signal skill/image-vision
git merge signal/skill/image-vision || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/image.ts` (image download, resize via sharp, base64 encoding)
- `src/image.test.ts` (8 unit tests)
- Image attachment handling in `src/channels/signal.ts`
- Image passing to agent in `src/index.ts` and `src/container-runner.ts`
- Image content block support in `container/agent-runner/src/index.ts`
- `sharp` npm dependency in `package.json`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/image.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

1. Rebuild the container (agent-runner changes need a rebuild):
   ```bash
   ./container/build.sh
   ```

2. Sync agent-runner source to group caches:
   ```bash
   for dir in data/sessions/*/agent-runner-src/; do
     cp container/agent-runner/src/*.ts "$dir"
   done
   ```

3. Restart the service:
   ```bash
   systemctl --user restart nanoclaw
   ```

## Phase 4: Verify

1. Send an image in a registered Signal chat
2. Check the agent responds with understanding of the image content
3. Check logs for "Processed image attachment":
   ```bash
   tail -50 groups/*/logs/container-*.log
   ```

## Troubleshooting

- **"Image - processing failed"**: Sharp may not be installed correctly. Run `npm ls sharp` to verify.
- **Agent doesn't mention image content**: Check container logs for "Loaded image" messages. If missing, ensure agent-runner source was synced to group caches.
- **Attachment not found**: Signal stores attachments in `~/.local/share/signal-cli/attachments/`. Verify the file exists and the NanoClaw user has read access.
