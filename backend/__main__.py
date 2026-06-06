"""Creamy framework CLI bootstrap."""

from __future__ import annotations

import os
import sys

import typer

from backend.app.framework import CreamyFramework


def _configure_logging() -> None:
    """Set the loguru level. INFO is off by default; raise it with CREAMY_VERBOSE / CREAMY_LOG_LEVEL."""
    from loguru import logger

    level = os.getenv("CREAMY_LOG_LEVEL")
    if not level:
        from backend.architecture.agent.settings import load_settings

        level = {0: "WARNING", 1: "INFO"}.get(load_settings().verbose, "DEBUG")
    logger.remove()
    logger.add(sys.stderr, level=level.upper())


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
    _configure_logging()
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
