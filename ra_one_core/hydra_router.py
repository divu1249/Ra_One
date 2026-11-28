import asyncio
import json
import logging
import os
import re
import socket
import sqlite3
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Optional
from urllib.parse import urlparse

import httpx

from schemas import HydraProviderStatus


logger = logging.getLogger("ra_one.hydra")


TelemetryCallback = Callable[[str, str], Awaitable[None]]
RoutingRole = Literal["actor", "critic", "fast"]


@dataclass
class ProviderConfig:
    name: str
    tier: str
    model: str
    env_key: str
    endpoint: str
    kind: str  # "gemini" | "openai_compat" | "freellmapi"
    fallback_env_keys: tuple[str, ...] = ()


class LowBandwidthRelayTransport(ABC):
    """Tier 2 abstract interface for low-bandwidth text-only relays (e.g. LoRa/edge-server)."""

    @abstractmethod
    async def transmit_compact(self, prompt_summary: str) -> Optional[str]:
        raise NotImplementedError


class DefaultNullRelay(LowBandwidthRelayTransport):
    async def transmit_compact(self, prompt_summary: str) -> Optional[str]:
        return None


class OfflineTaskQueue:
    """Tier 3 persistent SQLite queue recording tasks when all inference tiers are unreachable."""

    def __init__(self, db_path: str = "ra_one_offline_queue.db") -> None:
        self.db_path = db_path
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS offline_tasks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued'
                )
                """
            )
            conn.commit()

    def enqueue(self, task: str, reason: str) -> int:
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "INSERT INTO offline_tasks (task, reason, created_at, status) VALUES (?, ?, ?, 'queued')",
                (task, reason, time.time()),
            )
            conn.commit()
            return int(cur.lastrowid or 0)

    def pending_count(self) -> int:
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT COUNT(*) FROM offline_tasks WHERE status = 'queued'").fetchone()
            return int(row[0]) if row else 0

    def list_pending(self) -> list[dict[str, Any]]:
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute(
                "SELECT id, task, reason, created_at, status FROM offline_tasks WHERE status = 'queued' ORDER BY id ASC"
            ).fetchall()
            return [
                {"id": r[0], "task": r[1], "reason": r[2], "created_at": r[3], "status": r[4]}
                for r in rows
            ]

    def mark_flushed(self, task_id: int) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE offline_tasks SET status = 'flushed' WHERE id = ?", (task_id,))
            conn.commit()


@dataclass
class HydraCompletion:
    content: str
    provider: str
    model: str
    tier: str
    latency_ms: float
    tokens_estimated: int
    routed_via: Optional[str] = None
    fallback_attempts: Optional[str] = None


def normalize_freellmapi_base_url(raw_url: str) -> str:
    cleaned = raw_url.strip().rstrip("/")
    if not cleaned:
        return ""
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    cleaned = re.sub(r"/(?:chat/completions|models)$", "", cleaned, flags=re.IGNORECASE).rstrip("/")
    if not cleaned.lower().endswith("/v1"):
        cleaned = f"{cleaned}/v1"
    return cleaned


def is_html_response(content_type: str, raw_body: str) -> bool:
    ct = content_type.lower()
    trimmed = raw_body.lstrip()
    return "text/html" in ct or "application/xhtml" in ct or trimmed.startswith("<")


def _format_response_snippet(raw_body: str) -> str:
    return " ".join(raw_body.split())[:120]


def resolve_freellmapi_model(role: RoutingRole = "actor") -> str:
    if role == "critic":
        return os.getenv("FREELLMAPI_MODEL_CRITIC", "").strip() or "auto:smart"
    if role == "fast":
        return os.getenv("FREELLMAPI_MODEL_FAST", "").strip() or "auto:fast"
    return os.getenv("FREELLMAPI_MODEL_ACTOR", "").strip() or "auto:coding"


class HydraRouter:
    """Pillar 1 & 6: Resilient multi-provider router with automatic cascading failover and FreeLLMAPI overflow."""

    def __init__(self, relay: Optional[LowBandwidthRelayTransport] = None) -> None:
        self.relay = relay or DefaultNullRelay()
        self.queue = OfflineTaskQueue()
        self.timeout = httpx.Timeout(25.0, connect=8.0)
        self.freellmapi_timeout = httpx.Timeout(35.0, connect=8.0)
        self.freellmapi_cold_start_delay = 3.0
        self.provider_configs = [
            ProviderConfig(
                name="gemini",
                tier="TIER_0",
                model="gemini-4-hydrogen",
                env_key="GEMINI_API_KEY",
                endpoint="https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent",
                kind="gemini",
                fallback_env_keys=("GOOGLE_API_KEY", "API_KEY"),
            ),
            ProviderConfig(
                name="groq",
                tier="TIER_0",
                model="llama-3.3-70b-versatile",
                env_key="GROQ_API_KEY",
                endpoint="https://api.groq.com/openai/v1/chat/completions",
                kind="openai_compat",
            ),
            ProviderConfig(
                name="freellmapi",
                tier="TIER_0",
                model=resolve_freellmapi_model("actor"),
                env_key="FREELLMAPI_API_KEY",
                endpoint="",
                kind="freellmapi",
            ),
            ProviderConfig(
                name="deepseek",
                tier="TIER_0",
                model="deepseek-chat",
                env_key="DEEPSEEK_API_KEY",
                endpoint="https://api.deepseek.com/v1/chat/completions",
                kind="openai_compat",
            ),
            ProviderConfig(
                name="openrouter",
                tier="TIER_0",
                model="meta-llama/llama-3.3-70b-instruct",
                env_key="OPENROUTER_API_KEY",
                endpoint="https://openrouter.ai/api/v1/chat/completions",
                kind="openai_compat",
            ),
            ProviderConfig(
                name="local_slm",
                tier="TIER_1",
                model=os.getenv("LOCAL_LLM_MODEL", "llama3.2:3b"),
                env_key="LOCAL_LLM_URL",
                endpoint=os.getenv("LOCAL_LLM_URL", "").strip(),
                kind="openai_compat",
            ),
        ]
        self.health_state: dict[str, dict[str, Any]] = {
            cfg.name: {"healthy": self._is_configured(cfg), "last_error": None, "last_latency_ms": None}
            for cfg in self.provider_configs
        }
        self.active_provider: Optional[str] = None
        self.active_tier: str = "TIER_0"
        self.last_routed_via: Optional[str] = None
        self._freellmapi_probe_cache: Optional[dict[str, Any]] = None
        self._freellmapi_probe_ts: float = 0.0

    def _resolve_secret(self, cfg: ProviderConfig) -> str:
        if cfg.kind == "freellmapi":
            base_url = normalize_freellmapi_base_url(os.getenv("FREELLMAPI_BASE_URL", ""))
            api_key = os.getenv("FREELLMAPI_API_KEY", "").strip()
            return api_key if (base_url and api_key) else ""
        for key_name in (cfg.env_key, *cfg.fallback_env_keys):
            val = os.getenv(key_name, "").strip()
            if val:
                return val
        return ""

    def _is_configured(self, cfg: ProviderConfig) -> bool:
        return bool(self._resolve_secret(cfg))

    def _ordered_configs(self, preferred_provider: Optional[str] = None) -> list[ProviderConfig]:
        priority = os.getenv("FREELLMAPI_PRIORITY", "overflow").strip().lower()
        base_order = list(self.provider_configs)
        if priority == "primary":
            free_cfgs = [c for c in base_order if c.name == "freellmapi"]
            others = [c for c in base_order if c.name != "freellmapi"]
            base_order = free_cfgs + others

        if preferred_provider:
            return [c for c in base_order if c.name == preferred_provider] + [
                c for c in base_order if c.name != preferred_provider
            ]
        return base_order

    @staticmethod
    def _is_json_validate_error(msg: str) -> bool:
        lower = msg.lower()
        return (
            "json_validate_failed" in lower
            or "failed_generation" in lower
            or ("http 400" in lower and "json" in lower)
        )

    @staticmethod
    def _is_quota_exceeded_body(raw_text: str) -> bool:
        lower = raw_text.lower()
        if "quota_exceeded" in lower:
            return True
        try:
            parsed = json.loads(raw_text)
            if isinstance(parsed, dict):
                err = parsed.get("error")
                if isinstance(err, dict) and str(err.get("code", "")).lower() == "quota_exceeded":
                    return True
        except Exception:
            pass
        return False

    async def probe_freellmapi_health(self, force: bool = False) -> dict[str, Any]:
        """Lightweight cached probe (2s timeout, 30s TTL) against GET {FREELLMAPI_BASE_URL}/models."""
        base_url = normalize_freellmapi_base_url(os.getenv("FREELLMAPI_BASE_URL", ""))
        api_key = os.getenv("FREELLMAPI_API_KEY", "").strip()
        if not base_url or not api_key:
            return {
                "status": "unconfigured",
                "models_available": 0,
                "last_routed_via": self.last_routed_via,
            }

        now = time.monotonic()
        if not force and self._freellmapi_probe_cache is not None and (now - self._freellmapi_probe_ts) < 30.0:
            cached = dict(self._freellmapi_probe_cache)
            cached["last_routed_via"] = self.last_routed_via
            return cached

        models_url = f"{base_url}/models"
        result: dict[str, Any] = {
            "status": "unreachable",
            "models_available": 0,
            "last_routed_via": self.last_routed_via,
        }
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(
                    models_url,
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                raw_body = resp.text
                content_type = resp.headers.get("content-type", "")
                snippet = _format_response_snippet(raw_body)
                if is_html_response(content_type, raw_body):
                    msg = f"Probe HTTP {resp.status_code} HTML response: {snippet or '(empty)'}"
                    logger.warning("[HYDRA] FREELLMAPI %s", msg)
                    self.health_state["freellmapi"] = {
                        "healthy": False,
                        "last_error": msg[:180],
                        "last_latency_ms": None,
                    }
                elif resp.status_code == 200:
                    payload = json.loads(raw_body)
                    models_list = payload.get("data") if isinstance(payload, dict) else None
                    if not isinstance(models_list, list) and isinstance(payload, dict):
                        models_list = payload.get("models")
                    count = len(models_list) if isinstance(models_list, list) else 0
                    result = {
                        "status": "ready",
                        "models_available": count,
                        "last_routed_via": self.last_routed_via,
                    }
                    self.health_state["freellmapi"] = {
                        "healthy": True,
                        "last_error": None,
                        "last_latency_ms": self.health_state["freellmapi"].get("last_latency_ms"),
                    }
                else:
                    self.health_state["freellmapi"] = {
                        "healthy": False,
                        "last_error": f"Probe HTTP {resp.status_code}: {snippet}"[:180],
                        "last_latency_ms": None,
                    }
        except Exception as exc:
            self.health_state["freellmapi"] = {
                "healthy": False,
                "last_error": f"Probe error: {str(exc)[:120]}",
                "last_latency_ms": None,
            }

        self._freellmapi_probe_cache = dict(result)
        self._freellmapi_probe_ts = now
        return result

    def get_provider_statuses(self) -> list[HydraProviderStatus]:
        statuses: list[HydraProviderStatus] = []
        for cfg in self._ordered_configs():
            configured = self._is_configured(cfg)
            state = self.health_state[cfg.name]
            healthy = configured and (
                bool(state["healthy"]) or (state["last_error"] is None and state["last_latency_ms"] is None)
            )
            statuses.append(
                HydraProviderStatus(
                    name=cfg.name,
                    tier=cfg.tier,  # type: ignore[arg-type]
                    configured=configured,
                    healthy=healthy,
                    model=resolve_freellmapi_model("actor") if cfg.kind == "freellmapi" else cfg.model,
                    last_error=state["last_error"],
                    last_latency_ms=state["last_latency_ms"],
                )
            )
        return statuses

    def current_tier(self) -> str:
        for cfg in self._ordered_configs():
            configured = self._is_configured(cfg)
            state = self.health_state[cfg.name]
            healthy = configured and (
                bool(state["healthy"]) or (state["last_error"] is None and state["last_latency_ms"] is None)
            )
            if healthy:
                return cfg.tier
        return "TIER_3"

    async def _call_gemini(
        self, api_key: str, cfg: ProviderConfig, messages: list[dict[str, str]], json_mode: bool
    ) -> tuple[str, int]:
        system_parts = [m["content"] for m in messages if m["role"] == "system"]
        user_contents = [
            {
                "role": "model" if m["role"] == "assistant" else "user",
                "parts": [{"text": m["content"]}],
            }
            for m in messages
            if m["role"] != "system"
        ]
        payload: dict[str, Any] = {"contents": user_contents}
        if system_parts:
            payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
        if json_mode:
            payload["generationConfig"] = {"responseMimeType": "application/json"}

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                cfg.endpoint,
                headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                json=payload,
            )
            if resp.status_code == 400 and json_mode:
                payload.pop("generationConfig", None)
                resp = await client.post(
                    cfg.endpoint,
                    headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                    json=payload,
                )
            if resp.status_code == 429 or resp.status_code >= 500:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:240]}")
            resp.raise_for_status()
            data = resp.json()
            candidates = data.get("candidates", [])
            if not candidates:
                raise RuntimeError("Empty Gemini candidate response")
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts)
            usage = data.get("usageMetadata", {}).get("totalTokenCount", len(text) // 4)
            return text, int(usage)

    async def _call_freellmapi(
        self,
        api_key: str,
        cfg: ProviderConfig,
        messages: list[dict[str, str]],
        role: RoutingRole = "actor",
        max_tokens: int = 1400,
        on_telemetry: Optional[TelemetryCallback] = None,
    ) -> tuple[str, int, str, Optional[str], Optional[str]]:
        base_url = normalize_freellmapi_base_url(os.getenv("FREELLMAPI_BASE_URL", ""))
        if not base_url:
            raise RuntimeError("FREELLMAPI_BASE_URL not configured or invalid")

        target_model = resolve_freellmapi_model(role)
        cfg.model = target_model
        endpoint = f"{base_url}/chat/completions"

        # Zero-crash schema handling: do NOT force response_format on FreeLLMAPI upstream models
        body: dict[str, Any] = {
            "model": target_model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": max_tokens,
        }

        for attempt in (0, 1):
            async with httpx.AsyncClient(timeout=self.freellmapi_timeout) as client:
                resp = await client.post(
                    endpoint,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )

            raw_body = resp.text
            content_type = resp.headers.get("content-type", "")
            html_body = is_html_response(content_type, raw_body)
            snippet = _format_response_snippet(raw_body)
            is_transient_cold_start = resp.status_code in (502, 503, 504)

            if html_body or is_transient_cold_start:
                kind_label = "HTML" if html_body else (content_type or "transient")
                log_msg = f"[HYDRA] FREELLMAPI HTTP {resp.status_code} ({kind_label}): {snippet or '(empty body)'}"
                logger.warning("%s", log_msg)
                if on_telemetry:
                    await on_telemetry("telemetry", log_msg)

                if is_transient_cold_start and attempt == 0:
                    if on_telemetry:
                        await on_telemetry(
                            "telemetry",
                            f"[HYDRA] FREELLMAPI HTTP {resp.status_code} cold-start detected; retrying once in {int(round(self.freellmapi_cold_start_delay))}s...",
                        )
                    await asyncio.sleep(self.freellmapi_cold_start_delay)
                    continue

                raise RuntimeError(
                    f"HTTP {resp.status_code} {'HTML' if html_body else 'transient'} response from FreeLLMAPI: {snippet}"
                )

            if resp.status_code == 429 or resp.status_code >= 400 or self._is_quota_exceeded_body(raw_body):
                raise RuntimeError(f"HTTP {resp.status_code}: {snippet}")

            routed_via = resp.headers.get("x-routed-via")
            fallback_attempts = resp.headers.get("x-fallback-attempts")

            try:
                data = json.loads(raw_body)
            except Exception as exc:
                raise RuntimeError(f"Invalid JSON from FreeLLMAPI (HTTP {resp.status_code}): {snippet or exc}") from exc

            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError("Empty choices returned by FreeLLMAPI")
            text = choices[0].get("message", {}).get("content", "") or ""
            if not text:
                raise RuntimeError("Empty message content returned by FreeLLMAPI")
            usage = data.get("usage", {}).get("total_tokens", len(text) // 4)
            return text, int(usage), target_model, routed_via, fallback_attempts

        raise RuntimeError("FreeLLMAPI failed after cold-start retry")

    async def _call_openai_compat(
        self,
        api_key_or_url: str,
        cfg: ProviderConfig,
        messages: list[dict[str, str]],
        json_mode: bool,
        max_tokens: int = 1400,
    ) -> tuple[str, int]:
        endpoint = api_key_or_url if cfg.name == "local_slm" else cfg.endpoint
        if cfg.name == "local_slm" and not endpoint.endswith("/chat/completions"):
            endpoint = endpoint.rstrip("/") + "/v1/chat/completions"

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if cfg.name != "local_slm":
            headers["Authorization"] = f"Bearer {api_key_or_url}"

        candidate_models = [cfg.model]
        if cfg.name == "groq":
            try:
                async with httpx.AsyncClient(timeout=8.0) as discovery_client:
                    m_resp = await discovery_client.get("https://api.groq.com/openai/v1/models", headers=headers)
                    if m_resp.status_code == 200:
                        excluded = ("guard", "whisper", "tts", "orpheus", "playai", "canopylabs", "compound")
                        included = ("llama", "qwen", "mixtral", "gemma", "deepseek", "gpt-oss")
                        ids = [
                            m.get("id", "")
                            for m in m_resp.json().get("data", [])
                            if m.get("id")
                            and not any(bad in m["id"].lower() for bad in excluded)
                            and any(ok in m["id"].lower() for ok in included)
                        ]
                        ordered: list[str] = []
                        for pref in ("llama-3.3", "llama3-70b", "llama-3.1", "llama-3.", "qwen", "gpt-oss", "mixtral", "gemma"):
                            for mid in ids:
                                if pref in mid.lower() and mid not in ordered:
                                    ordered.append(mid)
                        for mid in ids:
                            if mid not in ordered:
                                ordered.append(mid)
                        if ordered:
                            candidate_models = ordered[:3]
                            cfg.model = ordered[0]
            except Exception:
                pass

        last_exc: Optional[Exception] = None
        for cand_model in candidate_models:
            enforce_json = json_mode and cfg.name in ("groq", "deepseek") and "qwen" not in cand_model.lower()

            async def send_req(use_json_fmt: bool, req_msgs: list[dict[str, str]]) -> httpx.Response:
                body: dict[str, Any] = {
                    "model": cand_model,
                    "messages": req_msgs,
                    "temperature": 0.1,
                    "max_tokens": max_tokens,
                }
                if use_json_fmt:
                    body["response_format"] = {"type": "json_object"}
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    return await client.post(endpoint, headers=headers, json=body)

            resp = await send_req(enforce_json, messages)
            if resp.status_code == 400 and enforce_json:
                detail = resp.text[:240]
                if self._is_json_validate_error(f"HTTP 400: {detail}"):
                    repaired = list(messages) + [
                        {
                            "role": "user",
                            "content": f"Previous JSON validator rejected strict schema ({detail[:120]}). Return plain text containing only the valid JSON object.",
                        }
                    ]
                    resp = await send_req(False, repaired)

            if resp.status_code in (404, 429) or resp.status_code >= 500 or (resp.status_code == 400 and "terms" in resp.text.lower()):
                last_exc = RuntimeError(f"HTTP {resp.status_code}: {resp.text[:240]}")
                if cfg.name == "groq":
                    continue
                raise last_exc
            if resp.status_code >= 400:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:240]}")
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            usage = data.get("usage", {}).get("total_tokens", len(text) // 4)
            cfg.model = cand_model
            return text, int(usage)

        if last_exc:
            raise last_exc
        raise RuntimeError(f"All candidate models failed for {cfg.name}")

    async def complete(
        self,
        messages: list[dict[str, str]],
        json_mode: bool = True,
        on_telemetry: Optional[TelemetryCallback] = None,
        max_tokens: int = 1400,
        preferred_provider: Optional[str] = None,
        role: RoutingRole = "actor",
    ) -> HydraCompletion:
        errors: list[str] = []
        ordered_cfgs = self._ordered_configs(preferred_provider)

        for cfg in ordered_cfgs:
            secret = self._resolve_secret(cfg)
            if not secret:
                continue

            route_model = resolve_freellmapi_model(role) if cfg.kind == "freellmapi" else cfg.model
            if on_telemetry:
                await on_telemetry("telemetry", f"[HYDRA] Routing inference to {cfg.name.upper()} ({cfg.tier} / {route_model})")

            started = time.perf_counter()
            routed_via: Optional[str] = None
            fallback_attempts: Optional[str] = None
            used_model = route_model
            try:
                if cfg.kind == "gemini":
                    content, tokens = await self._call_gemini(secret, cfg, messages, json_mode)
                elif cfg.kind == "freellmapi":
                    content, tokens, used_model, routed_via, fallback_attempts = await self._call_freellmapi(
                        secret, cfg, messages, role=role, max_tokens=max_tokens, on_telemetry=on_telemetry
                    )
                    if routed_via:
                        self.last_routed_via = routed_via
                else:
                    content, tokens = await self._call_openai_compat(secret, cfg, messages, json_mode, max_tokens=max_tokens)
                    used_model = cfg.model

                latency_ms = round((time.perf_counter() - started) * 1000.0, 2)
                self.health_state[cfg.name] = {
                    "healthy": True,
                    "last_error": None,
                    "last_latency_ms": latency_ms,
                }
                self.active_provider = cfg.name
                self.active_tier = cfg.tier

                if on_telemetry:
                    if cfg.kind == "freellmapi" and routed_via:
                        retry_suffix = (
                            f" (upstream retries: {fallback_attempts})"
                            if fallback_attempts is not None and str(fallback_attempts).strip() != ""
                            else ""
                        )
                        await on_telemetry(
                            "telemetry",
                            f"[HYDRA] FREELLMAPI responded in {latency_ms}ms via {routed_via}{retry_suffix}",
                        )
                    else:
                        await on_telemetry(
                            "telemetry",
                            f"[HYDRA] {cfg.name.upper()} responded in {latency_ms}ms (~{tokens} tokens).",
                        )

                return HydraCompletion(
                    content=content,
                    provider=cfg.name,
                    model=used_model,
                    tier=cfg.tier,
                    latency_ms=latency_ms,
                    tokens_estimated=tokens,
                    routed_via=routed_via,
                    fallback_attempts=fallback_attempts,
                )
            except (httpx.TimeoutException, httpx.ConnectError, socket.gaierror, OSError, RuntimeError, httpx.HTTPStatusError) as exc:
                err_msg = f"{cfg.name}: {type(exc).__name__} - {str(exc)}"
                errors.append(err_msg)
                self.health_state[cfg.name] = {
                    "healthy": False,
                    "last_error": str(exc)[:180],
                    "last_latency_ms": None,
                }
                if on_telemetry:
                    await on_telemetry(
                        "telemetry",
                        f"[HYDRA FAILOVER] {cfg.name.upper()} fault ({str(exc)[:100]}). Cascading to next provider...",
                    )
                await asyncio.sleep(0.05)

        # Tier 2: Low-Bandwidth Relay hook
        relay_reply = await self.relay.transmit_compact(messages[-1]["content"][:240] if messages else "")
        if relay_reply:
            self.active_tier = "TIER_2"
            return HydraCompletion(
                content=json.dumps({"thought": "Tier 2 relay response", "plan": [], "action": "respond", "response": relay_reply}),
                provider="low_bw_relay",
                model="relay-text",
                tier="TIER_2",
                latency_ms=0.0,
                tokens_estimated=len(relay_reply) // 4,
            )

        # Tier 3: Async Persistence Queue
        self.active_tier = "TIER_3"
        reason = "; ".join(errors) if errors else "No Tier 0/1 provider keys configured"
        raise RuntimeError(f"HYDRA_EXHAUSTED: {reason}")
