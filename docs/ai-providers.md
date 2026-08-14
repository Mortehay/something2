# Remote AI image providers

Points sprite, entity and tile image generation at an image service running on
another machine, instead of only the local `sprite-gen` container.

Admin UI: **AI Providers** in the sidebar (`/game/settings`). Admin only.

## What a provider is

A row in `ai_providers`: a URL, an optional auth header, an editable JSON
request template, and a selected model. Exactly one provider may be *active*;
the active one is the default for generation. With no active provider, nothing
changes — generation uses local `sprite-gen` exactly as before.

Only the **prompt** comes from the entity or tile row. Everything else in the
request body is the template you saved.

## Fields

| Field | Meaning |
|---|---|
| `Base URL` | The full URL that generates an image, e.g. `http://192.168.1.20:7860/sdapi/v1/txt2img` |
| `Auth header` / token | Optional. Sent only when both are set. The token is never returned by the API — the form shows "stored" instead |
| `Request template` | The POST body, verbatim, with placeholders substituted at call time |
| `Models path` | Appended to the base URL's origin for model discovery, e.g. `/sdapi/v1/sd-models` |
| `Models pointer` | Where the model names are in that response, e.g. `$[*].model_name` |
| `Image pointer` | Where the image is in the generate response, e.g. `images[0]`. Leave blank if the response body *is* the image |

### Placeholders

`{{prompt}}` `{{model}}` `{{seed}}` `{{width}}` `{{height}}`

A placeholder that is the whole value keeps its type — `"width": "{{width}}"`
sends `512`, not `"512"`, because most services reject stringly-typed
dimensions. Inside a longer string it interpolates as text. An unrecognised
placeholder is left as written rather than blanked, so a typo is visible in the
request instead of silently generating an image from an empty prompt.

### Pointer syntax

A small path evaluator, not JSONPath: keys and array indices only.

```
$[*].model_name      root is an array of objects      (Automatic1111)
models[*].name       a named array of objects         (Ollama)
data[*].id           OpenAI-compatible
images[0]            the first image
output.images[0].url nested single value
```

## Worked examples

### Automatic1111

```
Base URL       http://192.168.1.20:7860/sdapi/v1/txt2img
Models path    /sdapi/v1/sd-models
Models pointer $[*].model_name
Image pointer  images[0]
```

```json
{
  "prompt": "{{prompt}}",
  "steps": 20,
  "cfg_scale": 7,
  "width": "{{width}}",
  "height": "{{height}}",
  "seed": "{{seed}}",
  "override_settings": { "sd_model_checkpoint": "{{model}}" }
}
```

### An OpenAI-compatible image endpoint

```
Base URL       https://api.example.com/v1/images/generations
Auth header    Authorization        token: Bearer sk-…
Models path    /v1/models
Models pointer data[*].id
Image pointer  data[0].b64_json
```

```json
{ "model": "{{model}}", "prompt": "{{prompt}}", "size": "1024x1024", "response_format": "b64_json" }
```

## Choosing a provider per type

The generation panels have a **Generate with** selector: *Default* (follow the
active provider), *Local sprite-gen*, or a specific provider. This is a
per-generation choice.

The schema also supports pinning a type permanently — `entity_types` and
`tile_types` carry `ai_provider_mode` (`default` | `local` | `provider`) and
`ai_provider_id`, and the resolver honours them — but there is **no UI for
setting the pin yet**. Precedence, highest first: request body → the type's
stored pin → the active provider → local `sprite-gen`.

## Limitations

- **Static images only.** One request returns one image, so a remote provider
  cannot build the multi-frame directional atlas animated sprites need.
  Requesting frames > 1 fails the job with a message saying so. Use local
  `sprite-gen` for animation.
- **Sync services only.** ComfyUI's submit/poll/fetch queue is not supported
  yet (SOMET-334).
- **In-memory job registry.** A backend restart loses in-flight remote jobs;
  polling one afterwards reports that rather than hanging.

## Security

**An admin who can register a provider can make the backend issue HTTP
requests to any host the backend can reach.** That is inherent to the feature —
the target is a machine on your network — so *admin is a trusted role here*.

What is guarded:

- Only `http`/`https`. `file:`, `ftp:`, `gopher:` and the rest are refused at
  save time *and* at call time, because the column can be edited in psql.
- URLs with embedded credentials are refused.
- Redirects are followed at most 3 times, each hop re-validated, and the auth
  header is **dropped on a cross-origin hop** so the token cannot follow a 302
  to a host you never configured.
- Response bodies are size-capped (`AI_PROVIDER_MAX_IMAGE_BYTES`, default 32 MB).
- Timeouts are bounded: `AI_PROVIDER_DISCOVERY_TIMEOUT_MS` (10s) and
  `AI_PROVIDER_GENERATE_TIMEOUT_MS` (5 min).
- The auth token is never returned by any endpoint, and URLs in error messages
  are redacted of credentials and query strings.

The token is stored in plaintext in the database. Encrypting it would protect
it from nobody who cannot already read `DATABASE_URL` out of compose.
