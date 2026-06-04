"""Creamy framework CLI bootstrap."""

from __future__ import annotations

import typer

from backend.app.framework import CreamyFramework


def _instrument_creamy() -> None:
    try:
        import logfire

        logfire.configure()
    except ImportError:
        pass
    else:
        from loguru import logger

        logger.configure(handlers=[logfire.loguru_handler()])


def create_cli_app() -> typer.Typer:
    _instrument_creamy()
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
