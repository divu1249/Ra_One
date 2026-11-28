import os
import re
import sqlite3
import time
from typing import Any, Optional

import httpx


class EpisodicMemoryStore:
    """Pillar 5: Continuous Learning episodic memory (ChromaDB default, SQLite fallback, Supabase optional)."""

    def __init__(self, sqlite_path: str = "ra_one_episodic_memory.db") -> None:
        self.sqlite_path = sqlite_path
        self.backend = "sqlite"
        self._chroma_collection: Any = None
        self._init_sqlite()
        self._init_chroma()

    def _init_sqlite(self) -> None:
        with sqlite3.connect(self.sqlite_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS episodic_memory (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_type TEXT NOT NULL,
                    task_summary TEXT NOT NULL,
                    error_signature TEXT NOT NULL,
                    winning_strategy TEXT NOT NULL,
                    created_at REAL NOT NULL
                )
                """
            )
            conn.commit()

    def _init_chroma(self) -> None:
        try:
            import chromadb

            client = chromadb.PersistentClient(path="./chroma_memory")
            self._chroma_collection = client.get_or_create_collection(name="ra_one_episodes")
            self.backend = "chromadb"
        except Exception:
            self._chroma_collection = None
            self.backend = "sqlite"

    def status(self) -> dict[str, Any]:
        supabase_configured = bool(os.getenv("SUPABASE_URL", "").strip() and os.getenv("SUPABASE_KEY", "").strip())
        return {
            "backend": "supabase+local" if supabase_configured else self.backend,
            "supabase_configured": supabase_configured,
            "episode_count": self.count(),
        }

    def count(self) -> int:
        with sqlite3.connect(self.sqlite_path) as conn:
            row = conn.execute("SELECT COUNT(*) FROM episodic_memory").fetchone()
            return int(row[0]) if row else 0

    def list_episodes(self, limit: int = 25) -> list[dict[str, Any]]:
        with sqlite3.connect(self.sqlite_path) as conn:
            rows = conn.execute(
                """
                SELECT id, task_type, task_summary, error_signature, winning_strategy, created_at
                FROM episodic_memory
                ORDER BY id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [
                {
                    "id": r[0],
                    "task_type": r[1],
                    "task_summary": r[2],
                    "error_signature": r[3],
                    "winning_strategy": r[4],
                    "timestamp": r[5],
                }
                for r in rows
            ]

    async def record_episode(
        self,
        task_type: str,
        task_summary: str,
        error_signature: str,
        winning_strategy: str,
    ) -> dict[str, Any]:
        ts = time.time()
        with sqlite3.connect(self.sqlite_path) as conn:
            cur = conn.execute(
                """
                INSERT INTO episodic_memory (task_type, task_summary, error_signature, winning_strategy, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (task_type, task_summary[:300], error_signature[:200], winning_strategy[:800], ts),
            )
            conn.commit()
            ep_id = int(cur.lastrowid or 0)

        if self._chroma_collection is not None:
            try:
                doc = f"Task: {task_summary}\nError: {error_signature}\nStrategy: {winning_strategy}"
                self._chroma_collection.upsert(
                    ids=[f"ep_{ep_id}"],
                    documents=[doc],
                    metadatas=[
                        {
                            "task_type": task_type,
                            "error_signature": error_signature[:200],
                            "timestamp": ts,
                        }
                    ],
                )
            except Exception:
                pass

        supabase_url = os.getenv("SUPABASE_URL", "").strip()
        supabase_key = os.getenv("SUPABASE_KEY", "").strip()
        if supabase_url and supabase_key:
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    await client.post(
                        supabase_url.rstrip("/") + "/rest/v1/ra_one_episodic_memory",
                        headers={
                            "apikey": supabase_key,
                            "Authorization": f"Bearer {supabase_key}",
                            "Content-Type": "application/json",
                            "Prefer": "return=minimal",
                        },
                        json={
                            "task_type": task_type,
                            "task_summary": task_summary[:300],
                            "error_signature": error_signature[:200],
                            "winning_strategy": winning_strategy[:800],
                        },
                    )
            except Exception:
                pass

        return {
            "id": ep_id,
            "task_type": task_type,
            "task_summary": task_summary[:300],
            "error_signature": error_signature[:200],
            "winning_strategy": winning_strategy[:800],
            "timestamp": ts,
        }

    def recall(self, query: str, top_k: int = 3) -> list[dict[str, Any]]:
        stopwords = {
            "the", "and", "for", "with", "that", "this", "from", "into",
            "your", "about", "write", "python", "function", "script", "verify", "test", "using", "only",
        }
        tokens = {t for t in re.findall(r"[a-z0-9_]{2,}", query.lower()) if t not in stopwords}
        episodes = self.list_episodes(limit=100)
        if not episodes:
            return []

        scored: list[tuple[int, int, dict[str, Any]]] = []
        for ep in episodes:
            haystack = f"{ep['task_type']} {ep['task_summary']} {ep['error_signature']} {ep['winning_strategy']}".lower()
            ep_tokens = {t for t in re.findall(r"[a-z0-9_]{2,}", haystack) if t not in stopwords}
            overlap = len(tokens & ep_tokens)
            if overlap > 0:
                scored.append((overlap, int(ep.get("id", 0)), ep))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        results = [item[2] for item in scored[:top_k]]

        if len(results) < top_k:
            seen_ids = {int(r.get("id", 0)) for r in results}
            for ep in episodes:
                ep_id = int(ep.get("id", 0))
                if ep_id not in seen_ids:
                    results.append(ep)
                    seen_ids.add(ep_id)
                if len(results) >= top_k:
                    break
        return results
