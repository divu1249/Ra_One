import asyncio
import html
import ipaddress
import os
import re
import socket
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote_plus, unquote, urlparse, urljoin

try:
    import httpx  # type: ignore
except ImportError:
    httpx = None  # type: ignore

try:
    from bs4 import BeautifulSoup  # type: ignore
except ImportError:
    BeautifulSoup = None  # type: ignore

try:
    from duckduckgo_search import DDGS  # type: ignore
except ImportError:
    DDGS = None  # type: ignore


TelemetryFn = Callable[[str, str], Awaitable[None]]

MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2MB strict cap
DEFAULT_TIMEOUT_SECONDS = 12.0
MAX_CONTEXT_CHARS = 6000

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
]

BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata",
    "0.0.0.0",
    "::1",
    "::",
}


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str


@dataclass
class ScrapeResult:
    ok: bool
    url: str
    title: str
    text: str
    links: list[str]
    code_blocks: list[str]
    tier_used: str  # "tier1_httpx" | "tier2_jina" | "tier3_cache" | "blocked" | "error"
    wrapped_content: str
    error: str = ""


def _is_forbidden_ip(ip_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str.split("%")[0])
        return (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
        )
    except ValueError:
        return True


def validate_public_url(raw_url: str, resolve_dns: bool = True) -> tuple[bool, str]:
    """Validate URL scheme and guard against SSRF targeting private/loopback/metadata hosts."""
    trimmed = raw_url.strip()
    if not trimmed:
        return False, "Empty URL rejected."
    parsed = urlparse(trimmed)
    if parsed.scheme not in ("http", "https"):
        return False, f"Unsupported scheme '{parsed.scheme}'. Only http and https are allowed."
    hostname = (parsed.hostname or "").strip().lower()
    if not hostname:
        return False, "Missing hostname in URL."
    if (
        hostname in BLOCKED_HOSTNAMES
        or hostname.endswith(".local")
        or hostname.endswith(".internal")
        or hostname.endswith(".localhost")
    ):
        return False, f"SSRF Guard blocked restricted hostname: {hostname}"

    # Direct IP literal check
    try:
        ipaddress.ip_address(hostname.split("%")[0])
        if _is_forbidden_ip(hostname):
            return False, f"SSRF Guard blocked non-public IP: {hostname}"
        return True, ""
    except ValueError:
        pass

    if resolve_dns:
        try:
            infos = socket.getaddrinfo(hostname, None)
            if not infos:
                return False, f"DNS resolution returned no records for {hostname}"
            for info in infos:
                resolved_ip = str(info[4][0])
                if _is_forbidden_ip(resolved_ip):
                    return False, f"SSRF Guard blocked DNS target resolving to non-public IP ({resolved_ip})"
        except socket.gaierror as exc:
            return False, f"DNS resolution failed for {hostname}: {exc}"

    return True, ""


def wrap_untrusted_web_data(source_url: str, body: str) -> str:
    safe_source = source_url.replace('"', "").replace("<", "").replace(">", "")[:260]
    cleaned_body = body.replace("</untrusted_web_data>", "[/untrusted_web_data]")
    return f'<untrusted_web_data source="{safe_source}">\n{cleaned_body}\n</untrusted_web_data>'


def _extract_html_content(raw_html: str, base_url: str) -> tuple[str, str, list[str], list[str]]:
    title = ""
    code_blocks: list[str] = []
    links: list[str] = []

    if BeautifulSoup is not None:
        soup = BeautifulSoup(raw_html, "html.parser")
        if soup.title and soup.title.string:
            title = soup.title.string.strip()
        for pre in soup.find_all(["pre", "code"]):
            txt = pre.get_text("\n", strip=True)
            if len(txt) >= 12 and txt not in code_blocks:
                code_blocks.append(txt[:1500])
        for anchor in soup.find_all("a", href=True):
            href = str(anchor["href"]).strip()
            if href and not href.startswith("#") and not href.lower().startswith("javascript:"):
                resolved = urljoin(base_url, href)
                if resolved not in links:
                    links.append(resolved)
                if len(links) >= 15:
                    break
        for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
            tag.decompose()
        main_node = soup.find("main") or soup.find("article") or soup.body or soup
        text = main_node.get_text("\n", strip=True)
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        return title, "\n".join(lines), links, code_blocks[:6]

    # Pure-stdlib regex fallback when BeautifulSoup4 is not installed
    title_m = re.search(r"<title[^>]*>([\s\S]*?)</title>", raw_html, re.IGNORECASE)
    if title_m:
        title = html.unescape(re.sub(r"<[^>]+>", "", title_m.group(1))).strip()
    for code_m in re.findall(r"<(?:pre|code)[^>]*>([\s\S]*?)</(?:pre|code)>", raw_html, re.IGNORECASE):
        cleaned_code = html.unescape(re.sub(r"<[^>]+>", "", code_m)).strip()
        if len(cleaned_code) >= 12 and cleaned_code not in code_blocks:
            code_blocks.append(cleaned_code[:1500])
    for href in re.findall(r'href=["\']([^"\']+)["\']', raw_html, re.IGNORECASE):
        if href and not href.startswith("#") and not href.lower().startswith("javascript:"):
            resolved = urljoin(base_url, href)
            if resolved not in links:
                links.append(resolved)
            if len(links) >= 15:
                break
    stripped = re.sub(r"<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?</\1>", " ", raw_html, flags=re.IGNORECASE)
    stripped = re.sub(r"<[^>]+>", "\n", stripped)
    lines = [html.unescape(line.strip()) for line in stripped.splitlines() if line.strip()]
    return title, "\n".join(lines), links, code_blocks[:6]


def _extract_markdown_code_blocks(md_text: str) -> list[str]:
    blocks: list[str] = []
    for match in re.findall(r"```(?:[a-zA-Z0-9_+-]+)?\s*\n([\s\S]*?)```", md_text):
        snippet = match.strip()
        if len(snippet) >= 12:
            blocks.append(snippet[:1500])
        if len(blocks) >= 6:
            break
    return blocks


def _looks_like_js_wall(text: str) -> bool:
    lower = text.lower()
    markers = (
        "enable javascript",
        "javascript is required",
        "please turn javascript on",
        "checking your browser",
        "just a moment...",
        "cloudflare",
        "access denied",
    )
    return len(text.strip()) < 200 or any(m in lower for m in markers)


class WebIntelligenceEngine:
    """Resilient async tiered web search & scraper with SSRF protection and 2MB cap."""

    def __init__(self, knowledge_store: Optional[Any] = None) -> None:
        self.knowledge_store = knowledge_store
        self._ua_index = 0

    def _next_headers(self) -> dict[str, str]:
        ua = USER_AGENTS[self._ua_index % len(USER_AGENTS)]
        self._ua_index += 1
        return {
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
            "Accept-Language": "en-US,en;q=0.9",
        }

    async def _fetch_limited_bytes(self, url: str) -> tuple[int, str, str]:
        if httpx is None:
            raise RuntimeError("httpx package is not installed in Python environment.")

        current_url = url
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SECONDS, follow_redirects=False) as client:
            for _hop in range(5):
                allowed, reason = validate_public_url(current_url, resolve_dns=True)
                if not allowed:
                    raise PermissionError(reason)

                for attempt in range(3):
                    async with client.stream("GET", current_url, headers=self._next_headers()) as resp:
                        if resp.status_code in (301, 302, 303, 307, 308):
                            location = resp.headers.get("location", "").strip()
                            if not location:
                                raise RuntimeError(f"HTTP {resp.status_code} redirect missing Location header")
                            current_url = urljoin(current_url, location)
                            break
                        if resp.status_code in (429, 503) and attempt < 2:
                            await asyncio.sleep(0.6 * (2 ** attempt))
                            continue

                        chunks: list[bytes] = []
                        total = 0
                        async for chunk in resp.aiter_bytes():
                            remaining = MAX_RESPONSE_BYTES - total
                            if remaining <= 0:
                                break
                            if len(chunk) > remaining:
                                chunks.append(chunk[:remaining])
                                total += remaining
                                break
                            chunks.append(chunk)
                            total += len(chunk)

                        content_type = resp.headers.get("content-type", "")
                        encoding = resp.encoding or "utf-8"
                        decoded = b"".join(chunks).decode(encoding, errors="replace")
                        return resp.status_code, content_type, decoded
                else:
                    raise RuntimeError("Exceeded retry limit on rate-limited response")

        raise RuntimeError("Exceeded maximum redirect hops")

    async def web_search(
        self,
        query: str,
        max_results: int = 5,
        on_telemetry: Optional[TelemetryFn] = None,
    ) -> list[SearchResult]:
        clean_query = query.strip()
        if not clean_query:
            return []
        if on_telemetry:
            await on_telemetry("telemetry", f"[WEB] Searching: {clean_query[:120]}")

        results: list[SearchResult] = []

        # Primary: DuckDuckGo Search (no API key required)
        if DDGS is not None:
            try:
                def _run_ddgs() -> list[dict[str, Any]]:
                    with DDGS() as ddgs:
                        return list(ddgs.text(clean_query, max_results=max_results))

                raw_items = await asyncio.to_thread(_run_ddgs)
                for item in raw_items:
                    href = str(item.get("href") or item.get("url") or "").strip()
                    title = str(item.get("title") or "").strip()
                    body = str(item.get("body") or item.get("snippet") or "").strip()
                    ok, _ = validate_public_url(href, resolve_dns=False)
                    if ok and title:
                        results.append(SearchResult(title=title, url=href, snippet=body))
            except Exception:
                results = []

        # Secondary fallback: DuckDuckGo HTML endpoint via httpx
        if not results and httpx is not None:
            try:
                ddg_url = f"https://html.duckduckgo.com/html/?q={quote_plus(clean_query)}"
                status, _ctype, body = await self._fetch_limited_bytes(ddg_url)
                if status == 200 and body:
                    matches = re.findall(
                        r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)</a>',
                        body,
                        re.IGNORECASE,
                    )
                    for raw_href, raw_title, raw_snip in matches[:max_results]:
                        href = html.unescape(raw_href)
                        if "uddg=" in href:
                            extracted = href.split("uddg=", 1)[1].split("&", 1)[0]
                            href = unquote(extracted)
                        title = html.unescape(re.sub(r"<[^>]+>", "", raw_title)).strip()
                        snippet = html.unescape(re.sub(r"<[^>]+>", "", raw_snip)).strip()
                        ok, _ = validate_public_url(href, resolve_dns=False)
                        if ok and title:
                            results.append(SearchResult(title=title, url=href, snippet=snippet))
            except Exception:
                pass

        # Optional fallback: Tavily API if configured
        tavily_key = os.getenv("TAVILY_API_KEY", "").strip()
        if not results and tavily_key and httpx is not None:
            try:
                async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SECONDS) as client:
                    resp = await client.post(
                        "https://api.tavily.com/search",
                        json={
                            "api_key": tavily_key,
                            "query": clean_query,
                            "max_results": max_results,
                            "include_answer": False,
                        },
                    )
                    if resp.status_code == 200:
                        for item in resp.json().get("results", [])[:max_results]:
                            href = str(item.get("url") or "").strip()
                            ok, _ = validate_public_url(href, resolve_dns=False)
                            if ok:
                                results.append(
                                    SearchResult(
                                        title=str(item.get("title") or href),
                                        url=href,
                                        snippet=str(item.get("content") or ""),
                                    )
                                )
            except Exception:
                pass

        if on_telemetry:
            await on_telemetry("telemetry", f"[WEB] Search yielded {len(results)} public result(s).")
        return results[:max_results]

    async def scrape_url(
        self,
        url: str,
        on_telemetry: Optional[TelemetryFn] = None,
    ) -> ScrapeResult:
        clean_url = url.strip()
        allowed, reason = validate_public_url(clean_url, resolve_dns=True)
        if not allowed:
            if on_telemetry:
                await on_telemetry("telemetry", f"[WEB] Blocked unsafe URL ({reason})")
            return ScrapeResult(
                ok=False,
                url=clean_url,
                title="",
                text="",
                links=[],
                code_blocks=[],
                tier_used="blocked",
                wrapped_content=wrap_untrusted_web_data(clean_url, f"BLOCKED: {reason}"),
                error=reason,
            )

        # Check offline semantic cache early for quick lookup or offline fallback
        cached_doc = self.knowledge_store.get_by_url(clean_url) if self.knowledge_store else None

        if on_telemetry:
            await on_telemetry("telemetry", f"[WEB] Tier 1 scraping {clean_url}")

        tier1_failed_reason = ""
        try:
            status, ctype, raw_body = await self._fetch_limited_bytes(clean_url)
            if status == 403:
                tier1_failed_reason = "HTTP 403"
            elif status >= 400:
                tier1_failed_reason = f"HTTP {status}"
            else:
                if "html" in ctype.lower() or "<html" in raw_body[:400].lower():
                    title, text, links, code_blocks = _extract_html_content(raw_body, clean_url)
                else:
                    title = clean_url
                    text = raw_body
                    links = []
                    code_blocks = _extract_markdown_code_blocks(raw_body)

                if not _looks_like_js_wall(text):
                    bounded_text = text[:MAX_CONTEXT_CHARS]
                    wrapped = wrap_untrusted_web_data(clean_url, bounded_text)
                    if self.knowledge_store:
                        self.knowledge_store.upsert_document(
                            url=clean_url,
                            title=title or clean_url,
                            summary=bounded_text[:1800],
                            code_snippets=code_blocks[:5],
                        )
                    return ScrapeResult(
                        ok=True,
                        url=clean_url,
                        title=title or clean_url,
                        text=bounded_text,
                        links=links,
                        code_blocks=code_blocks,
                        tier_used="tier1_httpx",
                        wrapped_content=wrapped,
                    )
                tier1_failed_reason = "minimal content (<200 chars) or JS wall"
        except Exception as exc:
            tier1_failed_reason = str(exc)

        # Tier 2: JS/SPA fallback via r.jina.ai
        if on_telemetry:
            await on_telemetry("telemetry", f"[WEB] Tier 2 Jina fallback ({tier1_failed_reason}) for {clean_url}")
        try:
            jina_url = f"https://r.jina.ai/{clean_url}"
            status2, _ctype2, md_body = await self._fetch_limited_bytes(jina_url)
            if status2 == 200 and len(md_body.strip()) >= 80:
                bounded_md = md_body.strip()[:MAX_CONTEXT_CHARS]
                first_line = bounded_md.splitlines()[0].lstrip("# ").strip() if bounded_md.splitlines() else clean_url
                code_blocks = _extract_markdown_code_blocks(bounded_md)
                wrapped = wrap_untrusted_web_data(clean_url, bounded_md)
                if self.knowledge_store:
                    self.knowledge_store.upsert_document(
                        url=clean_url,
                        title=first_line[:160] or clean_url,
                        summary=bounded_md[:1800],
                        code_snippets=code_blocks[:5],
                    )
                return ScrapeResult(
                    ok=True,
                    url=clean_url,
                    title=first_line[:160] or clean_url,
                    text=bounded_md,
                    links=[],
                    code_blocks=code_blocks,
                    tier_used="tier2_jina",
                    wrapped_content=wrapped,
                )
        except Exception as exc2:
            tier1_failed_reason = f"{tier1_failed_reason}; tier2: {exc2}"

        # Tier 3: Offline semantic knowledge cache
        if cached_doc:
            if on_telemetry:
                await on_telemetry("telemetry", f"[WEB] Tier 3 serving cached knowledge for {clean_url}")
            summary = str(cached_doc.get("summary", ""))[:MAX_CONTEXT_CHARS]
            return ScrapeResult(
                ok=True,
                url=clean_url,
                title=str(cached_doc.get("title", clean_url)),
                text=summary,
                links=[],
                code_blocks=list(cached_doc.get("code_snippets", [])),
                tier_used="tier3_cache",
                wrapped_content=wrap_untrusted_web_data(clean_url, summary),
            )

        return ScrapeResult(
            ok=False,
            url=clean_url,
            title="",
            text="",
            links=[],
            code_blocks=[],
            tier_used="error",
            wrapped_content=wrap_untrusted_web_data(clean_url, f"SCRAPE FAILED: {tier1_failed_reason}"),
            error=tier1_failed_reason,
        )

    async def research_topic(
        self,
        query: str,
        max_urls: int = 3,
        on_telemetry: Optional[TelemetryFn] = None,
    ) -> dict[str, Any]:
        if on_telemetry:
            await on_telemetry("telemetry", f"[WEB] Researching topic: {query[:120]}")
        search_hits = await self.web_search(query, max_results=max_urls + 2, on_telemetry=on_telemetry)
        scraped_docs: list[dict[str, Any]] = []

        for hit in search_hits[:max_urls]:
            scraped = await self.scrape_url(hit.url, on_telemetry=on_telemetry)
            if scraped.ok:
                scraped_docs.append(
                    {
                        "title": scraped.title,
                        "url": scraped.url,
                        "tier": scraped.tier_used,
                        "wrapped_content": scraped.wrapped_content,
                        "code_blocks": scraped.code_blocks,
                    }
                )

        # Tier 3 offline knowledge fallback when live search/scrape returned nothing
        if not scraped_docs and self.knowledge_store:
            cached_matches = self.knowledge_store.search(query, top_k=max_urls)
            if cached_matches and on_telemetry:
                await on_telemetry("telemetry", f"[WEB] Tier 3 serving {len(cached_matches)} cached doc(s) for '{query[:60]}'")
            for doc in cached_matches:
                doc_url = str(doc.get("url", "cache://local"))
                doc_sum = str(doc.get("summary", ""))
                scraped_docs.append(
                    {
                        "title": str(doc.get("title", "Cached Knowledge")),
                        "url": doc_url,
                        "tier": "tier3_cache",
                        "wrapped_content": wrap_untrusted_web_data(doc_url, doc_sum),
                        "code_blocks": list(doc.get("code_snippets", [])),
                    }
                )

        combined_blocks = [d["wrapped_content"] for d in scraped_docs]
        if not combined_blocks and search_hits:
            snippet_text = "\n".join(f"- {h.title} ({h.url}): {h.snippet}" for h in search_hits)
            combined_blocks.append(wrap_untrusted_web_data("duckduckgo://search", snippet_text))

        return {
            "query": query,
            "search_results": [{"title": h.title, "url": h.url, "snippet": h.snippet} for h in search_hits],
            "documents": scraped_docs,
            "context_block": "\n\n".join(combined_blocks)[: MAX_CONTEXT_CHARS * 2],
        }
