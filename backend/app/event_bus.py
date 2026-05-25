"""Async pub/sub bus — every component publishes events to it, consumers subscribe."""
from __future__ import annotations
import asyncio
from typing import AsyncIterator
from collections import deque


class EventBus:
    def __init__(self, history: int = 200) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._recent: deque[dict] = deque(maxlen=history)

    def publish(self, event: dict) -> None:
        self._recent.append(event)
        dead = []
        for q in self._subscribers:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self._subscribers.discard(q)

    async def subscribe(self, replay_recent: bool = True) -> AsyncIterator[dict]:
        q: asyncio.Queue = asyncio.Queue(maxsize=1024)
        self._subscribers.add(q)
        try:
            if replay_recent:
                for ev in list(self._recent):
                    yield ev
            while True:
                yield await q.get()
        finally:
            self._subscribers.discard(q)


bus = EventBus()
