# Vision Helper MCP Server

An MCP server that adds **vision capability to any LLM**. Models that cannot see images
(the text-only LLM driving your MCP client) call `vision_helper_analyze_image`, and this server
forwards the image to a **vision-capable model on [OpenRouter](https://openrouter.ai)**,
then returns the analysis as text.

Built as a more robust replacement for
[TheNomadInOrbit/Vision-MCP-Server](https://github.com/TheNomadInOrbit/Vision-MCP-Server):
no build-step assumptions, lazy key resolution, Windows `setx`-style environment variable
support, image format sniffing, request retries, and clear actionable errors.

## Requirements

- Node.js 18+ (tested on 22)
- An [OpenRouter API key](https://openrouter.ai/keys) (`sk-or-v1-...`)

## Install

```powershell
npm install -g vision-helper-mcp-server
```

This installs the `vision-helper-mcp` command globally (the compiled `dist` is the
only published content). Quick check:

```powershell
vision-helper-mcp --help
```

### Development / from source

```powershell
git clone https://github.com/<you>/vision-helper-mcp-server.git
cd vision-helper-mcp-server
npm install
npm run build
node dist\index.js --help
```

## Configuration

The API key and options are resolved, in priority order:

1. **Process environment variables** — set in your MCP client's `env`/`environment`
   config (recommended; this is also where `OPENROUTER_MODEL` usually lives).
2. **Windows user environment variables** — read directly from the registry
   (`HKCU\Environment`), i.e. what `setx` writes. This matters: GUI apps (VS Code,
   Kilo, Claude Desktop, ...) do **not** re-read user env vars changed after they
   were launched, so a key set with `setx` after launching the client would otherwise
   be invisible. The server reads the registry itself, so `setx` values work with no
   client restart.
3. **Windows system environment variables** — registry
   `HKLM\SYSTEM\...\Session Manager\Environment`.

On non-Windows platforms only step 1 applies.

| Variable | Purpose | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (required for analysis) | — |
| `OPENROUTER_MODEL` | Default vision model ID | `qwen/qwen3.8-max` |
| `OPENROUTER_FALLBACK_MODEL` | Fallback model tried automatically when the primary model's provider is busy or fails | `google/gemini-3.7-flash` |
| `OPENROUTER_QUICK_MODEL` | Default model for `vision_helper_quick_analyze` | `meta/muse-glimmer-30b` |
| `MAX_IMAGE_SIZE` | Max image payload bytes | `10485760` (10 MB) |
| `OPENROUTER_TIMEOUT_MS` | Per-request timeout | `120000` (120 s) |

> The model can also be chosen **per call** via the `model` argument of
> `vision_helper_analyze_image` / `vision_helper_quick_analyze`, overriding the
> environment default.

### Kilo (VS Code extension) configuration

Add this server as its **own** MCP entry (it does not replace or share tools with any
other vision server you have configured). This example appends a `vision-helper` entry
to the `mcp` object in your Kilo config file (e.g. `~/.config/kilo/kilo.json` on
Windows):

```json
"vision-helper": {
  "type": "local",
  "command": ["vision-helper-mcp"],
  "enabled": true,
  "timeout": 120000,
  "environment": {
    "OPENROUTER_MODEL": "qwen/qwen3.8-max"
  }
}
```

`OPENROUTER_API_KEY` is optional here: if the key is set as a Windows user environment
variable (`setx OPENROUTER_API_KEY sk-or-v1-...`), the server picks it up automatically
by reading the registry — no client restart needed. Add the key to the `environment`
block only if you want it explicit in the config.

### Claude Desktop / other clients

```json
{
  "mcpServers": {
    "vision-helper": {
      "command": "vision-helper-mcp",
      "env": {
        "OPENROUTER_API_KEY": "sk-or-v1-...",
        "OPENROUTER_MODEL": "qwen/qwen3.8-max"
      }
    }
  }
}
```

## Tools

This server is a standalone MCP server with its own tool names
(`vision_helper_*`), so it can run side by side with other vision MCP servers
without tool collisions.

### `vision_helper_analyze_image`

Analyze one or more images with an OpenRouter vision model.

| Argument | Type | Description |
|---|---|---|
| `image` | `string \| string[]` | **Required.** An http(s) URL, local file path, `file://` URI, `data:` URI, or raw base64 string. Pass an array (up to 5) to analyze several images together, e.g. to compare screenshots. Only PNG, JPEG, WebP, and GIF are accepted (the formats OpenRouter supports for vision input); relative file paths resolve against the MCP client's working directory, so prefer absolute paths or URLs. |
| `prompt` | `string` | Optional instruction, e.g. `"Transcribe all text in this screenshot"`. Defaults to a general detailed description. |
| `model` | `string` | OpenRouter model ID, e.g. `qwen/qwen3.8-max`. Defaults to `OPENROUTER_MODEL`, then to the built-in default. |
| `max_tokens` | `number` | Max tokens for the answer (64–16000). |
| `temperature` | `number` | Sampling temperature (0–2). |

If the model's provider is busy or a request fails transiently (HTTP 429, 5xx,
timeout, or network error), the server automatically retries with the
`OPENROUTER_FALLBACK_MODEL` model (`google/gemini-3.7-flash` by default) so the
analysis does not fail. The response header shows which model actually answered
and notes when a fallback was used.

Examples of things to ask your assistant:

- "What is in this image? https://example.com/photo.jpg"
- "Analyze the screenshot at C:\Users\me\Pictures\shot.png"
- "Compare these two images: img1.png and img2.png" (pass an array)
- "Read the text from this image and list the objects: <path>"

### `vision_helper_quick_analyze`

Analyze an image **fast and cheap** for time-sensitive checks. Uses a low-latency,
high-throughput default model, caps its output, and forces minimal reasoning —
ideal for a quick yes/no, a short caption, or an object check when speed matters
more than exhaustive detail.

| Argument | Type | Description |
|---|---|---|
| `image` | `string` | **Required.** An http(s) URL, local file path, `file://` URI, `data:` URI, or raw base64 string. |
| `prompt` | `string` | A short question or instruction (max 500 chars), e.g. `"Is this icon red?"`. Defaults to a concise description. |
| `model` | `string` | OpenRouter model ID. Defaults to `OPENROUTER_QUICK_MODEL`, then to `meta/muse-glimmer-30b`. |

The default `meta/muse-glimmer-30b` is chosen for cost and speed (very cheap per
token, low latency, high throughput); override it globally with
`OPENROUTER_QUICK_MODEL` or per call with the `model` argument.

Examples of things to ask your assistant:

- "Quickly, what is in this image? <path>"
- "Is this screenshot blurry? <url>"
- "Give me a one-line caption for this image: <path>"

### Which analysis tool should I use?

| Need | Tool |
|---|---|
| Detailed, thorough understanding — transcribe all text, describe objects/people/layout, reason about complex content, or compare several images at once | `vision_helper_analyze_image` |
| A fast, cheap, concise answer — a yes/no, a short caption, an object/color check, "is this blurry?", or a high-volume/time-sensitive check | `vision_helper_quick_analyze` |

Both tools describe images to an LLM that cannot see them. Prefer
`vision_helper_analyze_image` when completeness, precision, or detail matters more
than speed (it can also take an **array** of up to 5 images to compare). Prefer
`vision_helper_quick_analyze` when latency and cost matter more than detail and a
single image needs just a quick read.

### `vision_helper_list_models`

List vision-capable models currently on OpenRouter (filtered to image-input models) so
you or the user can pick one. Arguments: `search` (substring on ID/name, e.g. `gemini`,
`qwen`, `claude`), `limit` (default 25), `offset`, `response_format` (`markdown`|`json`).

### `vision_helper_check_config`

Diagnose setup: shows whether an API key was found, **which source it came from**
(client env / Windows user vars / Windows system vars), the default model, and the
size/time limits. The key is always masked (e.g. `sk-or-…40a0`).

## Reliability notes

- The server starts even when no key is configured; key resolution is lazy, so a key
  set with `setx` works without restarting anything.
- Chat-completion requests retry up to 3 times on 429 / 5xx / network errors, honoring
  `Retry-After` when present. If a model's provider is still busy after retries,
  `vision_helper_analyze_image` automatically falls back to the
  `OPENROUTER_FALLBACK_MODEL` model (`google/gemini-3.7-flash` by default) before giving up.
- Image downloads are streamed with a hard byte cap and a 30 s timeout; MIME type is
  sniffed from magic bytes, so raw base64 payloads need no explicit type. Only the
  formats OpenRouter supports for vision input are accepted: PNG, JPEG, WebP, GIF
  (others are rejected with conversion guidance before anything is uploaded).
- Remote image URLs are validated before fetching: redirects are followed manually
  (max 3 hops) and every hop must be a public http(s) host — private, loopback,
  link-local, and unresolved hosts are refused.
- The model catalog used by `vision_helper_list_models` is cached in-process for
  10 minutes.
- Errors returned to the model are actionable: invalid key (401), insufficient credits
  (402), unknown model (404, with a hint to call `vision_helper_list_models`), rate limit
  (429), oversized images (with the exact limit), and unsupported formats.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `vision_helper_analyze_image` returns "No OpenRouter API key found" | Run `vision_helper_check_config`. Set the key in the client's `environment`, or `setx OPENROUTER_API_KEY sk-or-v1-...` and start the client fresh. |
| "resolved from: Windows user environment variables" but the key is stale | Keys are read from the registry each time a tool runs, so an updated `setx` is picked up immediately — no reboot needed. |
| "Error: Model not found on OpenRouter (HTTP 404)" | The model ID is invalid, renamed, or deprecated. Run `vision_helper_list_models` and pass a current ID via the `model` argument. |
| "Error: Insufficient OpenRouter credits (HTTP 402)" | Add credits at https://openrouter.ai/settings/credits. |
| "Image is N bytes, which exceeds MAX_IMAGE_SIZE" | Shrink/compress the image, or raise `MAX_IMAGE_SIZE` (cap 50 MB). |
| "The N images total X bytes, exceeding the aggregate limit" | Analyzes are capped at 25 MB total across all images per request — split into multiple calls. |
| "OpenRouter vision models only accept PNG, JPEG, WebP, or GIF" | Convert the image (e.g. to PNG/JPEG) and retry — these are the formats OpenRouter supports for vision input. |
| "Error: OpenRouter rate limit or quota exceeded (HTTP 429)" | Wait a moment and retry; the server already retries transient 429s automatically. |
| HTTP 400 on a valid image | Some models accept fewer formats — try `qwen/qwen3.8-max` or `openai/gpt-5` family, or convert the image to PNG/JPEG. |

## Security

- The API key is only sent to OpenRouter over HTTPS; it is never logged, and
  `vision_helper_check_config` reports only a masked prefix.
- Keys are read from environment variables / the registry — never from files in this
  repository.
- The analysis tool reads local files only when explicitly requested, validates remote
  URLs against private/internal hosts, and only ever uploads image content in the four
  formats OpenRouter accepts.

## License

MIT
