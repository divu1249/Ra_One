import asyncio
import json
import os
import sys
import time
from typing import AsyncGenerator

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from agent_graph import AgentState, build_agent_graph
from hydra_router import HydraRouter
from learning_engine import LearningEngine
from memory_store import EpisodicMemoryStore
from mutation_engine import MutationEngine
from schemas import ChatRequest, HealthResponse
from web_engine import WebIntelligenceEngine


load_dotenv()

START_TIME = time.time()

app = FastAPI(title="Ra.One 2.0 Autonomous Core", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

router = HydraRouter()
memory_store = EpisodicMemoryStore()
mutation_engine = MutationEngine()
learning_engine = LearningEngine(mutation_engine=mutation_engine)
web_engine = WebIntelligenceEngine(knowledge_store=learning_engine.knowledge)


def format_sse(event_type: str, content: str) -> str:
    payload = json.dumps({"type": event_type, "content": content})
    return f"data: {payload}\n\n"


@app.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    free_probe = await router.probe_freellmapi_health()
    providers = router.get_provider_statuses()
    active_tier = router.current_tier()
    has_healthy = any(p.healthy for p in providers)
    service_status = "online" if active_tier == "TIER_0" else ("degraded" if has_healthy else "degraded")

    tools = learning_engine.list_learned_tools()
    knowledge_summary = learning_engine.knowledge.list_all()
    docs_count = int(knowledge_summary.get("documents_count", 0))

    return HealthResponse(
        status=service_status,  # type: ignore[arg-type]
        active_tier=active_tier,  # type: ignore[arg-type]
        active_provider=router.active_provider,
        uptime_seconds=round(time.time() - START_TIME, 2),
        providers=providers,
        episodic_memory=memory_store.status(),
        sandbox={
            "ready": True,
            "python_executable": sys.executable,
            "timeout_seconds": int(os.getenv("SANDBOX_TIMEOUT_SECONDS", "10")),
        },
        offline_queue_depth=router.queue.pending_count(),
        web_engine="ready",
        learned_tools=[str(t.get("name", "")) for t in tools if t.get("name")],
        learned_tools_count=len(tools),
        knowledge_docs=docs_count,
        knowledge_docs_count=docs_count,
        snapshots_count=mutation_engine.snapshots_count(),
        freellmapi=free_probe["status"],  # type: ignore[arg-type]
        freellmapi_models_available=int(free_probe.get("models_available", 0)),
        last_routed_via=free_probe.get("last_routed_via"),
    )


@app.get("/memory")
async def get_episodic_memory():
    return {
        "status": memory_store.status(),
        "episodes": memory_store.list_episodes(limit=30),
    }


@app.get("/knowledge")
async def get_knowledge_base():
    return learning_engine.knowledge.list_all()


@app.get("/tools/learned")
async def get_learned_tools():
    tools = learning_engine.list_learned_tools()
    return {
        "count": len(tools),
        "tools": tools,
    }


@app.get("/mutations")
async def list_mutations():
    return {
        "allow_live_mutations": mutation_engine.is_live_mutations_enabled(),
        "snapshots_count": mutation_engine.snapshots_count(),
        "mutations": mutation_engine._load_ledger(),
    }


@app.post("/mutations/rollback")
async def rollback_latest_mutation():
    result = mutation_engine.rollback_latest()
    if not result.get("ok"):
        raise HTTPException(status_code=404, detail=str(result.get("error", "No rollback available.")))
    return result


@app.post("/mutations/{mutation_id}/apply")
async def apply_staged_mutation(mutation_id: str):
    result = mutation_engine.apply_mutation(mutation_id, critic_approved=True)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=str(result.get("error", "Failed to apply mutation.")))
    return result


@app.post("/mutations/{mutation_id}/rollback")
async def rollback_specific_mutation(mutation_id: str):
    ledger = mutation_engine._load_ledger()
    rec = next((r for r in ledger if r.get("mutation_id") == mutation_id), None)
    if not rec:
        raise HTTPException(status_code=404, detail=f"Mutation '{mutation_id}' not found.")
    rel = str(rec.get("target_file", ""))
    abs_target = os.path.abspath(os.path.join(mutation_engine.base_dir, rel))
    restored = mutation_engine._restore_from_snapshot(abs_target, rec.get("snapshot_path"))
    if not restored:
        raise HTTPException(status_code=400, detail="Snapshot missing for rollback.")
    rec["status"] = "rolled_back"
    mutation_engine._save_ledger(ledger)
    return {"ok": True, "mutation_id": mutation_id, "target_file": rel, "status": "rolled_back"}


@app.get("/queue")
async def get_offline_queue():
    return {
        "pending_count": router.queue.pending_count(),
        "items": router.queue.list_pending(),
    }


@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    async def event_stream() -> AsyncGenerator[str, None]:
        queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

        async def emit(event_type: str, content: str) -> None:
            await queue.put((event_type, content))

        await emit("telemetry", f"[RECEIVED] {request.message}")

        compiled_graph = build_agent_graph(
            router=router,
            memory=memory_store,
            emit=emit,
            web_engine=web_engine,
            mutation_engine=mutation_engine,
            learning_engine=learning_engine,
        )

        initial_state: AgentState = {
            "task": request.message,
            "memory_context": [],
            "learned_rules": [],
            "web_context": "",
            "source_urls": [],
            "plan": [],
            "generated_code": "",
            "target_file": request.target_file,
            "query": None,
            "url": None,
            "tool_name": None,
            "tool_description": None,
            "pending_mutation_id": None,
            "action": "",
            "execution_output": "",
            "exit_code": 0,
            "traceback": "",
            "critique": "",
            "iteration_count": 0,
            "max_iterations": request.max_iterations,
            "status": "init",
            "final_response": "",
            "actor_raw": "",
        }

        async def run_graph() -> None:
            try:
                final_state = await compiled_graph.ainvoke(initial_state)
                if final_state.get("status") in ("verified", "approved"):
                    output_msg = final_state.get("final_response") or final_state.get("execution_output") or "Verified."
                    await emit("final", output_msg)
                else:
                    summary = final_state.get("critique") or final_state.get("traceback") or "Max iterations reached."
                    await emit("error", f"[CIRCUIT BREAKER] Loop halted after {final_state.get('iteration_count', 0)} iterations: {summary}")
            except Exception as exc:
                err_text = str(exc)
                if "HYDRA_EXHAUSTED" in err_text:
                    task_id = router.queue.enqueue(request.message, err_text)
                    await emit("error", f"[TIER 3 QUEUE] All providers unreachable. Task #{task_id} persisted to offline queue: {err_text}")
                else:
                    await emit("error", f"CRITICAL FAILURE: {err_text}")
            finally:
                await queue.put(("__DONE__", ""))

        task = asyncio.create_task(run_graph())
        try:
            while True:
                event_type, content = await queue.get()
                if event_type == "__DONE__":
                    break
                yield format_sse(event_type, content)
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
