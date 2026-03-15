# Signal Channel Setup

Connect NanoClaw to Signal via [signal-cli](https://github.com/AsamK/signal-cli). The channel supports both dedicated phone numbers and shared accounts (Note to Self).

## Prerequisites

- A phone number to register with Signal (dedicated or shared)
- signal-cli v0.14.x or later
- Java 25+ (required by signal-cli v0.14.x)

## Install signal-cli

### macOS

```bash
brew install signal-cli
```

### Linux (x86_64)

Download the [Java distribution](https://github.com/AsamK/signal-cli/releases) and extract to `/opt`:

```bash
curl -fSL -o signal-cli.tar.gz \
  https://github.com/AsamK/signal-cli/releases/download/v0.14.1/signal-cli-0.14.1.tar.gz
sudo tar -xzf signal-cli.tar.gz -C /opt
sudo ln -sf /opt/signal-cli-0.14.1/bin/signal-cli /usr/local/bin/signal-cli
```

Install Java 25 via [Eclipse Temurin](https://adoptium.net/):

```bash
# Debian/Ubuntu
curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | sudo tee /usr/share/keyrings/adoptium.asc
echo "deb [signed-by=/usr/share/keyrings/adoptium.asc] https://packages.adoptium.net/artifactory/deb $(. /etc/os-release && echo $VERSION_CODENAME) main" \
  | sudo tee /etc/apt/sources.list.d/adoptium.list
sudo apt update && sudo apt install -y temurin-25-jdk
```

### Linux ARM64 (Raspberry Pi)

Follow the x86_64 instructions above, then install the native libsignal library:

signal-cli's Java distribution only bundles x86_64 native libraries. On ARM64 you need `libsignal_jni.so` from [exquo/signal-libs-build](https://github.com/exquo/signal-libs-build):

```bash
# Check which version signal-cli needs
ls /opt/signal-cli-0.14.1/lib/libsignal-client-*.jar
# e.g. libsignal-client-0.87.4.jar → need v0.87.x

# Download closest available ARM64 build (check releases for exact match)
curl -fSL -o libsignal.tar.gz \
  https://github.com/exquo/signal-libs-build/releases/download/libsignal_v0.87.3/libsignal_jni.so-v0.87.3-aarch64-unknown-linux-gnu.tar.gz
tar -xzf libsignal.tar.gz
sudo cp libsignal_jni.so /usr/lib64/
```

Verify it works:

```bash
signal-cli --version
```

## Register a Phone Number

### Dedicated number (recommended)

Register a number that only the assistant uses:

```bash
signal-cli -a +1YOURNUMBER register
# You'll receive an SMS or voice call with a verification code
signal-cli -a +1YOURNUMBER verify CODE
```

### Shared account (Note to Self)

Link to an existing Signal account. Messages are exchanged via Note to Self:

```bash
signal-cli link -n "NanoClaw"
# This prints a sgnl:// URI. Convert it to a QR code to scan:
# Option 1: Use qrencode (install with apt/brew)
#   signal-cli link -n "NanoClaw" 2>&1 | head -1 | xargs qrencode -t UTF8
# Option 2: Paste the URI into an online QR generator
# Then scan with Signal: Settings → Linked Devices → Link New Device
```

## Configure NanoClaw

Add to `.env`:

```bash
SIGNAL_ACCOUNT=+1YOURNUMBER
SIGNAL_CLI_PATH=/usr/local/bin/signal-cli   # or: signal-cli (if in PATH)
SIGNAL_MANAGE_DAEMON=true

# Only if assistant has its own dedicated number:
ASSISTANT_HAS_OWN_NUMBER=true
```

Build and start:

```bash
npm run build
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux: systemctl --user restart nanoclaw
```

## Register a Chat

After the service starts, register the chat where messages should be delivered:

```bash
# For a dedicated number — use the sender's Signal UUID or phone number
# (check logs for the exact JID when you first message the assistant)
npx tsx setup/index.ts --step register -- \
  --jid "signal:<sender-uuid-or-phone>" \
  --name "YourName" \
  --trigger "@YourAssistantName" \
  --folder main \
  --channel signal \
  --is-main \
  --no-trigger-required

# For Note to Self — the JID is the assistant's own account
npx tsx setup/index.ts --step register -- \
  --jid "signal:+1YOURNUMBER" \
  --name "Me" \
  --trigger "@YourAssistantName" \
  --folder main \
  --channel signal \
  --is-main \
  --no-trigger-required
```

**Note:** signal-cli v0.14.x identifies senders by UUID instead of phone number. The first time someone messages the assistant, their JID appears in the logs as `signal:<uuid>`. Use that UUID when registering the chat.

## Running as a Service User

If NanoClaw runs as a dedicated user (e.g., `nanoclaw`) and you want the agent to access another user's files via bind mounts:

1. Add the service user to the file owner's group:
   ```bash
   sudo usermod -aG otheruser nanoclaw
   ```

2. Set the home directory to group-readable:
   ```bash
   chmod 750 /home/otheruser
   ```

3. Recreate the user session to pick up the new group:
   ```bash
   sudo loginctl terminate-user nanoclaw
   # systemd will restart the service automatically if linger is enabled
   ```

NanoClaw automatically forwards the host user's supplementary groups into the container, so the agent inherits the group access.

## Troubleshooting

**"Signal daemon failed to start"** — Check that signal-cli can run standalone:
```bash
signal-cli -a +1YOURNUMBER daemon --http 127.0.0.1:7583
```

**"User +NUMBER is not registered"** — The signal-cli data directory doesn't have the account. If you registered as a different user, copy the data:
```bash
sudo cp -a /home/otheruser/.local/share/signal-cli/data/* \
  /home/nanoclaw/.local/share/signal-cli/data/
sudo chown -R nanoclaw:nanoclaw /home/nanoclaw/.local/share/signal-cli/
```

**"bad parameter type SignedPreKeyStore"** — Version mismatch between `libsignal_jni.so` and the signal-cli JAR. Ensure the native library version matches the `libsignal-client-*.jar` version in signal-cli's lib directory.

**Messages show as "Unknown" sender** — The profile name wasn't set. NanoClaw sets it automatically on connect (using `ASSISTANT_NAME` from `.env`). If it still shows Unknown, restart the service.

**ARM64: "no signal_jni in java.library.path"** — The native library isn't in a path Java can find. Copy it to `/usr/lib64/` or the path shown in the error.
