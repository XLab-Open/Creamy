---
name: Bug report
about: Report a bug to help improve Creamy.
title: ''
labels: 'bug'
assignees: ''
---

## Describe the bug

A clear and concise description of what the bug is.

## To reproduce

Steps to reproduce the behavior. A minimal command or snippet is ideal:

```bash
uv run creamy run "..."     # or: uv run creamy chat / uv run creamy gateway
```

## Expected behavior

What you expected to happen.

## Actual behavior / logs

What actually happened. Paste the error or traceback — **redact any API keys or
secrets** first:

```text
...
```

## Environment

- Creamy version or git commit SHA:
- Python version (`python --version`):
- OS (e.g. Ubuntu 24.04, macOS 14):
- Channel (CLI / Telegram / Feishu):
- Model (`CREAMY_MODEL`, e.g. `openai:gpt-4o`):
- Installed via (`uv sync` / pip / plugin):

## Additional context

Relevant config (redact secrets), enabled plugins/skills, or anything else that
helps narrow it down.
