import json
import os
import re
import time
from typing import Any, Optional

from mutation_engine import MutationEngine


TOOL_NAME_PATTERN = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]{1,48}$")


class KnowledgeStore:
    """Semantic web cache & distilled episodic rules persisted to knowledge_store.json."""

    def __init__(self, store_path: str = "data/knowledge_store.json") -> None:
        self.store_path = store_path
        self._data: dict[str, Any] = {"documents": [], "rules": []}
        self._loaded = False

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        if os.path.exists(self.store_path):
            try:
                with open(self.store_path, "r", encoding="utf-8") as handle:
                    parsed = json.load(handle)
                if isinstance(parsed, dict):
                    self._data = {
                        "documents": list(parsed.get("documents", [])),
                        "rules": list(parsed.get("rules", [])),
                    }
            except Exception:
                self._data = {"documents": [], "rules": []}
        self._loaded = True

    def _persist(self) -> None:
        os.makedirs(os.path.dirname(os.path.abspath(self.store_path)), exist_ok=True)
        with open(self.store_path, "w", encoding="utf-8") as handle:
            json.dump(self._data, handle, indent=2)

    def upsert_document(
        self,
        url: str,
        title: str,
        summary: str,
        code_snippets: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        self._ensure_loaded()
        now = time.time()
        doc = {
            "url": url,
            "title": title[:200],
            "summary": summary[:2500],
            "code_snippets": (code_snippets or [])[:6],
            "timestamp": now,
        }
        docs: list[dict[str, Any]] = self._data["documents"]
        for idx, existing in enumerate(docs):
            if existing.get("url") == url:
                docs[idx] = doc
                self._persist()
                return doc
        docs.append(doc)
        if len(docs) > 200:
            docs.pop(0)
        self._persist()
        return doc

    def get_by_url(self, url: str) -> Optional[dict[str, Any]]:
        self._ensure_loaded()
        for doc in reversed(self._data["documents"]):
            if doc.get("url") == url:
                return doc
        return None

    def search(self, query: str, top_k: int = 3) -> list[dict[str, Any]]:
        self._ensure_loaded()
        tokens = set(re.findall(r"[a-z0-9_]{2,}", query.lower()))
        docs = self._data["documents"]
        if not docs:
            return []
        scored: list[tuple[int, float, dict[str, Any]]] = []
        for doc in docs:
            haystack = f"{doc.get('title', '')} {doc.get('url', '')} {doc.get('summary', '')}".lower()
            doc_tokens = set(re.findall(r"[a-z0-9_]{2,}", haystack))
            overlap = len(tokens & doc_tokens)
            if overlap > 0:
                scored.append((overlap, float(doc.get("timestamp", 0)), doc))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [item[2] for item in scored[:top_k]]

    def record_rule(
        self,
        task_domain: str,
        error_signature: str,
        winning_strategy: str,
        source_urls: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        self._ensure_loaded()
        rule = {
            "id": len(self._data["rules"]) + 1,
            "task_domain": task_domain[:120],
            "error_signature": error_signature[:180],
            "winning_strategy": winning_strategy[:800],
            "source_urls": (source_urls or [])[:5],
            "timestamp": time.time(),
        }
        self._data["rules"].append(rule)
        if len(self._data["rules"]) > 200:
            self._data["rules"].pop(0)
        self._persist()
        return rule

    def recall_rules(self, query: str, top_k: int = 3) -> list[dict[str, Any]]:
        self._ensure_loaded()
        rules = self._data["rules"]
        if not rules:
            return []
        tokens = set(re.findall(r"[a-z0-9_]{2,}", query.lower()))
        scored: list[tuple[int, int, dict[str, Any]]] = []
        for rule in rules:
            haystack = f"{rule.get('task_domain', '')} {rule.get('error_signature', '')} {rule.get('winning_strategy', '')}".lower()
            r_tokens = set(re.findall(r"[a-z0-9_]{2,}", haystack))
            overlap = len(tokens & r_tokens)
            if overlap > 0:
                scored.append((overlap, int(rule.get("id", 0)), rule))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        return [item[2] for item in scored[:top_k]]

    def list_all(self) -> dict[str, Any]:
        self._ensure_loaded()
        return {
            "documents_count": len(self._data["documents"]),
            "rules_count": len(self._data["rules"]),
            "documents": list(reversed(self._data["documents"]))[:50],
            "rules": list(reversed(self._data["rules"]))[:50],
        }


class LearningEngine:
    """Continuous learning: semantic web cache, rule distillation, and dynamic tool synthesis."""

    def __init__(
        self,
        knowledge_path: str = "data/knowledge_store.json",
        tools_dir: str = "tools/learned",
        mutation_engine: Optional[MutationEngine] = None,
    ) -> None:
        self.knowledge = KnowledgeStore(knowledge_path)
        self.mutation_engine = mutation_engine or MutationEngine()
        self.tools_dir = tools_dir.strip("/")
        self.abs_tools_dir = os.path.join(self.mutation_engine.base_dir, self.tools_dir)
        self.registry_path = os.path.join(self.abs_tools_dir, "registry.json")

    def _load_registry(self) -> list[dict[str, Any]]:
        if not os.path.exists(self.registry_path):
            return []
        try:
            with open(self.registry_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def _save_registry(self, items: list[dict[str, Any]]) -> None:
        os.makedirs(self.abs_tools_dir, exist_ok=True)
        with open(self.registry_path, "w", encoding="utf-8") as handle:
            json.dump(items, handle, indent=2)

    def list_learned_tools(self) -> list[dict[str, Any]]:
        return self._load_registry()

    def build_tool_prompt_block(self) -> str:
        tools = self.list_learned_tools()
        if not tools:
            return "None registered yet."
        lines = []
        for tool in tools[:15]:
            lines.append(f"- {tool['name']} ({tool['file_path']}): {tool['description']}")
        return "\n".join(lines)

    def promote_tool(
        self,
        tool_name: str,
        description: str,
        code: str,
        critic_approved: bool = True,
    ) -> dict[str, Any]:
        clean_name = tool_name.strip()
        if not TOOL_NAME_PATTERN.match(clean_name):
            return {
                "ok": False,
                "error": "Invalid tool_name. Use 2-49 alphanumeric/underscore characters starting with a letter or underscore.",
            }
        rel_path = f"{self.tools_dir.rstrip('/')}/{clean_name}.py".replace("\\", "/")
        staged = self.mutation_engine.stage_and_verify(rel_path, code)
        if not staged.get("passed"):
            return {"ok": False, "error": str(staged.get("report", "Tool verification failed."))}

        applied = self.mutation_engine.apply_mutation(str(staged["mutation_id"]), critic_approved=critic_approved)
        if not applied.get("ok"):
            return {"ok": False, "error": str(applied.get("error", "Tool registration failed."))}

        registry = self._load_registry()
        entry = {
            "name": clean_name,
            "description": description.strip()[:300] or f"Learned Python utility {clean_name}",
            "file_path": rel_path,
            "created_at": time.time(),
        }
        registry = [r for r in registry if r.get("name") != clean_name]
        registry.append(entry)
        self._save_registry(registry)

        self.knowledge.record_rule(
            task_domain="tool_synthesis",
            error_signature="learned_tool",
            winning_strategy=f"Promoted reusable tool '{clean_name}' at {rel_path}: {entry['description']}",
        )
        return {"ok": True, "tool": entry, "mutation_id": staged["mutation_id"]}

    @staticmethod
    def infer_domain(task: str) -> str:
        lower = task.lower()
        if any(k in lower for k in ("http", "scrape", "web", "url", "search", "api")):
            return "web_intelligence"
        if any(k in lower for k in ("mutat", "diff", "refactor", "file", "module")):
            return "self_mutation"
        if any(k in lower for k in ("regex", "parse", "json", "csv", "text")):
            return "data_parsing"
        return "algorithm_engineering"
