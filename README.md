# Sectium DevTools

Fast-iterating, zero-Chrome-extension DevTools, Inspect, Console, and Cross-Tab IDE plane for the Sectium Host Device Boundary.

## Architecture

Sectium separates visual rendering from inspection and tooling into two orthogonal, interchangeable NDJSON channels over local OS pipes (`\\.\pipe\sectium-dev` on Windows, `/tmp/sectium-dev.sock` on POSIX) or remote TCP+mTLS:

- **`channel: 'display'`** — Pure visual art surface. Zero embedded DevTools drawers, zero IDE chrome, zero agent overlays.
- **`channel: 'command'`** — Headless UART-style (`ttyS0`) control, DevTools, Inspect, Console, and Cross-Tab IDE plane (`SectiumDevToolsPlane`).

### Key Capabilities

- **Zero Chrome Extensions Required:** External IDEs (`vscode`, `antigravity`), AI agents, and CLI tools bind directly over `channel: 'command'` with full cross-tab visibility.
- **Native WHATWG `ReadableStream`:** `SectiumDevToolsPlane.createEventStream()` emits typed lifecycle and cross-tab context events supporting `.tee()`, `TransformStream`, and `WritableStream` fan-out.
- **Declarative HTML5 `<b8g-*>` Custom Elements:** Streamable UI surfaces using strict `data-*` attributes:
  - `<b8g-sectium-devtools data-channel="command" data-cross-tab="true"></b8g-sectium-devtools>`
  - `<b8g-sectium-command data-pipe="\\.\pipe\sectium-dev" data-channel="command"></b8g-sectium-command>`
  - `<b8g-sectium-display data-pipe="\\.\pipe\sectium-dev" data-channel="display" data-surface="canvas"></b8g-sectium-display>`
- **Interchangeable Kitty-Ink TUI Sink:** `kitty-ink-sink.mts` renders structured command/DevTools streams directly to Kitty/ANSI terminal surfaces without requiring a GUI display channel.

## Repository Layout

| Path | Description |
| :--- | :--- |
| `src/protocol.mts` | Dual-channel NDJSON wire protocol and transport pipe resolution |
| `src/device-host.mts` | Sectium Host Device server managing `command` and `display` channels |
| `src/device-client.mts` | Stateless network-device client and sanitized power-on environment builder |
| `src/devtools-plane.mts` | `SectiumDevToolsPlane` cross-tab registry, IDE/agent client binding, and WHATWG `ReadableStream` |
| `src/kitty-ink-sink.mts` | Interchangeable Kitty-Ink TUI stream sink |
| `src/*.test.mts` | Hermetic unit tests (`node --test src/*.test.mts`) |
| `docs/SECTIUM-HOST-DEVICE-BOUNDARY.md` | Full Host Device Boundary architecture specification |

## Running Tests

```sh
node --test src/devtools-plane.test.mts src/kitty-ink-sink.test.mts src/sectium-device.test.mts
```

## Related Repositories

- [`awesome-os/sectium-browser`](https://github.com/awesome-os/sectium-browser) — Consumer-facing Sectium Browser with Sectium Canvas pure-art New Tab and Windows installer.

## License

BSD-3-Clause. See [LICENSE](LICENSE).

## Quick Start (Windows / Linux / macOS)

```sh
# Clone & enter repository (all platforms)
git clone https://github.com/awesome-os/sectium-devtools.git && cd sectium-devtools
```
