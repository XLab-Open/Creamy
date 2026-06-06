"""Creamy framework package."""

from importlib import import_module
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as metadata_version

from backend.app.framework import CreamyFramework
from backend.hooks.hookspecs import hookimpl
from backend.tools.tools import tool

__all__ = ["CreamyFramework", "hookimpl", "tool"]

try:
    __version__ = import_module("backend._version").version
except ModuleNotFoundError:
    try:
        __version__ = metadata_version("creamy")
    except PackageNotFoundError:
        __version__ = "0.0.0"
