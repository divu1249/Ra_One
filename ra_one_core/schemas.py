from typing import Any, Literal, Optional
from pydantic import BaseModel, Field, model_validator


SSEEventType = Literal[
    "telemetry",
    "memory",
    "actor",
    "code",
    "critic",
    "error",
    "final",
]


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, description="User directive for Ra.One 2.0")
    max_iterations: int = Field(default=5, ge=1, le=10)
    target_file: Optional[str] = Field(default=None)


class ActorOutput(BaseModel):
    thought: str = Field(..., min_length=1, description="Concise tactical reasoning")
    plan: list[str] = Field(default_factory=list, description="Ordered execution steps")
    action: Literal[
        "run_python",
        "mutate_code",
        "audit_code",
        "respond",
        "web_search",
        "scrape_url",
        "research_topic",
        "promote_tool",
    ] = Field(..., description="Selected execution primitive")
    code: str = Field(default="", description="Python code or proposed file content")
    target_file: Optional[str] = Field(default=None, description="Target file for audit or mutation")
    query: Optional[str] = Field(default=None, description="Search/research query")
    url: Optional[str] = Field(default=None, description="Target URL for scraping")
    tool_name: Optional[str] = Field(default=None, description="Reusable tool identifier for promote_tool")
    tool_description: Optional[str] = Field(default=None, description="Reusable tool summary")
    response: str = Field(default="", description="Direct response when action is respond")


class CriticVerdict(BaseModel):
    approved: bool = Field(..., description="True only when output and execution are strictly verified")
    faults: list[str] = Field(default_factory=list, description="Exact list of detected faults")
    corrective_directive: str = Field(default="", description="Surgical fix instruction for Actor")

    @model_validator(mode="after")
    def validate_rejection_details(self) -> "CriticVerdict":
        cleaned_faults = [f.strip() for f in self.faults if f and f.strip()]
        self.faults = cleaned_faults
        self.corrective_directive = self.corrective_directive.strip()
        if not self.approved:
            if not self.faults:
                raise ValueError("Rejected CriticVerdict must list at least one fault.")
            if not self.corrective_directive:
                raise ValueError("Rejected CriticVerdict must provide a non-empty corrective_directive.")
        return self


class HydraProviderStatus(BaseModel):
    name: str
    tier: Literal["TIER_0", "TIER_1", "TIER_2", "TIER_3"]
    configured: bool
    healthy: bool
    model: str
    last_error: Optional[str] = None
    last_latency_ms: Optional[float] = None


class HealthResponse(BaseModel):
    status: Literal["online", "degraded", "offline"]
    core: str = "RA.ONE 2.0 // H.A.R.T."
    active_tier: Literal["TIER_0", "TIER_1", "TIER_2", "TIER_3"]
    active_provider: Optional[str] = None
    uptime_seconds: float
    providers: list[HydraProviderStatus]
    episodic_memory: dict[str, Any]
    sandbox: dict[str, Any]
    offline_queue_depth: int
    web_engine: str = "ready"
    learned_tools: list[str] = Field(default_factory=list)
    learned_tools_count: int = 0
    knowledge_docs: int = 0
    knowledge_docs_count: int = 0
    snapshots_count: int = 0
    freellmapi: Literal["ready", "unreachable", "unconfigured"] = "unconfigured"
    freellmapi_models_available: int = 0
    last_routed_via: Optional[str] = None

