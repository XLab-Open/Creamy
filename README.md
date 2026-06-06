# Creamy

**A hackable, hook-first AI agent that works across your terminal and chat apps.**

Creamy is a small agent runtime you can actually take apart. The turn loop is built
on [pluggy](https://pluggy.readthedocs.io/): every stage — resolving a session,
loading state, building the prompt, calling the model, rendering and dispatching the
reply — is a hook you can override. The shipped behaviour is just a set of default
plugins, so replacing a piece never means forking the core.

The same pipeline drives the CLI, Telegram, Feishu, and any channel you wire up, so an
agent you tune in your terminal behaves the same way in a group chat.

## Install

```bash
pip install creamy
```

From source:

```bash
git clone https://github.com/lss/creamy.git
cd creamy
uv sync
```

## Run

```bash
uv run creamy cli                         # interactive REPL
uv run creamy run "summarize this repo"   # one-shot turn
uv run creamy gateway                     # listen on configured channels
```

## Run with Docker

Requires Docker with the Compose v2 plugin (`docker compose`). From the repo root:

```bash
cp env.example .env     # fill in your model/provider keys
docker compose up -d    # build + start (or: make up)
docker compose logs -f  # follow logs   (or: make logs)
docker compose down     # stop          (or: make down)
```

The stack is defined in `compose.yaml` (root); the image is built from
`docker/Dockerfile`. Your working directory mounts at `/workspace`, so dropping a
`creamy-reqs.txt` (extra pip deps) or `startup.sh` (custom launch) there is picked up
automatically.

## How a turn flows

Every inbound message — from any channel — runs through the same pipeline. Each arrow
is a hook point:

```
resolve_session → load_state → build_prompt → run_model
                                                  │
            dispatch_outbound ← render_outbound ← save_state
```

Built-in behaviour is registered as plugins first; anything you register later wins.
There are no privileged code paths. If an `AGENTS.md` file is present in the workspace,
it is folded into the system prompt automatically.

Worth reading first:

- `backend/app/framework.py` — the framework runtime and turn orchestration
- `backend/architecture/schemas/hookspecs.py` — the hook contract
- `backend/architecture/schemas/hook_impl.py` — the built-in hook implementations
- `backend/architecture/skills/skills.py` — skill discovery

## Extend it

A plugin is any object whose methods are decorated with `hookimpl`:

```python
from backend import hookimpl


class EchoPlugin:
    @hookimpl
    def build_prompt(self, message, session_id, state):
        return f"[echo] {message['content']}"

    @hookimpl
    async def run_model(self, prompt, session_id, state):
        return prompt
```

Ship it as a package and register it under the `creamy` entry-point group:

```toml
[project.entry-points."creamy"]
echo = "my_package.plugin:EchoPlugin"
```

Skills are a lighter alternative: a `SKILL.md` file with validated frontmatter, loaded
on demand instead of imported as code.

## CLI

| Command              | Description                              |
| -------------------- | ---------------------------------------- |
| `creamy cli`         | Interactive REPL                         |
| `creamy run MESSAGE` | Single turn, then exit                   |
| `creamy gateway`     | Run channel listeners (Telegram, Feishu) |
| `creamy install`     | Install / sync plugin dependencies       |
| `creamy update`      | Upgrade plugin dependencies              |
| `creamy login openai`| OpenAI Codex OAuth login                 |

Lines beginning with `/` enter internal command mode (`/help`, `/skill name=...`,
`/fs.read path=README.md`). `creamy install` / `creamy update` manage a separate uv
project for plugins, defaulting to `~/.creamy/creamy-project` (override with
`CREAMY_PROJECT`).

## Configuration

Settings are read from `CREAMY_*` environment variables (see `env.example`).

| Variable                     | Default                              | Description                          |
| ---------------------------- | ------------------------------------ | ------------------------------------ |
| `CREAMY_MODEL`               | `openrouter:qwen/qwen3-coder-next`   | Model identifier (`provider:model`)  |
| `CREAMY_API_KEY`             | —                                    | Provider key (optional after login)  |
| `CREAMY_API_BASE`            | —                                    | Custom provider endpoint             |
| `CREAMY_API_FORMAT`          | `completion`                         | `completion`, `responses`, `messages`|
| `CREAMY_CLIENT_ARGS`         | —                                    | JSON passed to the model client      |
| `CREAMY_MAX_STEPS`           | `50`                                 | Max tool-use iterations per turn     |
| `CREAMY_MAX_TOKENS`          | `1024`                               | Max tokens per model call            |
| `CREAMY_MODEL_TIMEOUT_SECONDS` | —                                  | Per-call model timeout (seconds)     |
| `CREAMY_HOME`                | `~/.creamy`                          | Runtime data directory               |

## Development

```bash
make install            # sync deps + install pre-commit hooks
uv run ruff check .     # lint
uv run mypy backend     # type-check
uv run pytest -q        # tests
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow.

## License

Licensed under the [Apache License 2.0](./LICENSE).
