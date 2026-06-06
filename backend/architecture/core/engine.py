"""Tape-storage engine — project-owned thin layer over republic's tape runtime.

``ModelEngine`` owns per-tape append-only storage and the default selection
context; ``Tape`` is the per-tape view returned by :meth:`ModelEngine.tape`.

Model calls do **not** run here — they run through LangGraph in ``llm/graph.py``.
This engine only persists and replays tape entries (messages, anchors, events).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from republic import LLM
from republic.tape import Tape

if TYPE_CHECKING:
    from backend.architecture.core.store import AsyncTapeStore, TapeStore
    from backend.architecture.core.tape_types import TapeContext

# Placeholder model id — model resolution/network never happens through this
# engine; the real model is chosen per-call by ``llm/graph.py``.
_PLACEHOLDER_MODEL = "creamy:engine"


class ModelEngine(LLM):
    """Append-only tape storage + default context (model calls live in LangGraph)."""

    def __init__(
        self,
        tape_store: TapeStore | AsyncTapeStore,
        context: TapeContext | None = None,
    ) -> None:
        super().__init__(model=_PLACEHOLDER_MODEL, tape_store=tape_store, context=context)


__all__ = ["ModelEngine", "Tape"]
