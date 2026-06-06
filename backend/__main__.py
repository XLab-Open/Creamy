"""Creamy framework CLI bootstrap."""

from __future__ import annotations

import typer

from backend.app.framework import CreamyFramework
from backend.observability.logging import setup_logging


def create_cli_app() -> typer.Typer:
    setup_logging()
    framework = CreamyFramework()
    framework.load_hooks()
    app = framework.create_cli_app()

    if not app.registered_commands:

        @app.command("help")
        def _help() -> None:
            typer.echo("No CLI command loaded.")

    return app


app = create_cli_app()

if __name__ == "__main__":
    app()
