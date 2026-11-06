# GPU box access

How to open the GPU box's web pages from a browser on the same LAN.

## Set the address

Add the box's IP address to your local `.env` (gitignored, so the address stays
out of the repository):

```
GPU_BOX_HOST=<IP address of the GPU box>
```

Every `<GPU_BOX_HOST>` below means that value. Replace it by hand when you paste
a URL into a browser. Nothing in the backend or compose reads this variable: it
is only a place to record the address.

## Web pages

| Page | URL |
|---|---|
| Pixel Art Generator | `http://<GPU_BOX_HOST>:8001/` |
| API docs (Swagger UI) | `http://<GPU_BOX_HOST>:8001/docs` |
| Model Orchestrator | `http://<GPU_BOX_HOST>:7860/` |

To print the URLs from your `.env` values:

```bash
set -a; . ./.env; set +a
echo "http://$GPU_BOX_HOST:8001/"
echo "http://$GPU_BOX_HOST:8001/docs"
echo "http://$GPU_BOX_HOST:7860/"
```

## Authentication

The pages themselves load without a login. API calls to port 8001 can answer
`401` without a bearer token, so a button on a page can fail even though the page
loaded.

Create the key on the box, under Settings → Create key. The game's **AI Providers**
form (`/game/settings`) stores the token write-only, so you cannot read it back
from there. Do not commit a token to this repository.

## If the pages stop loading

- The box gets its address from DHCP, and it has changed before. Find the current
  address and update `GPU_BOX_HOST`.
- Update the base URL of each AI Provider that uses the box as well, because the
  game reads the address from those saved settings and not from `.env`.
- Check that the box is on and that your machine is on the same LAN.

## Related

- [ai-providers.md](ai-providers.md): registering the box as a provider for the game.
