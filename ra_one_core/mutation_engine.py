import ast
import difflib
import importlib
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from sandbox import run_python_sandbox


IMMUTABLE_KERNEL_FILES = {
    "mutation_engine.py",
    "ra_one_core/mutation_engine.py",
    "sandbox.py",
    "ra_one_core/sandbox.py",
    "hydra_router.py",
    "ra_one_core/hydra_router.py",
    "agent_graph.py",
    "ra_one_core/agent_graph.py",
    "main.py",
    "ra_one_core/main.py",
    "server/mutation.ts",
    "server/sandbox.ts",
    "server/hydra.ts",
    "server.ts",
    ".env",
    ".env.local",
}

ALLOWED_MUTATION_PREFIXES = (
    "tools/learned/",
    "strategies/",
    "ra_one_core/tools/learned/",
    "ra_one_core/strategies/",
    "ra_one_core/sandbox_probe.py",
)


@dataclass
class MutationRecord:
    mutation_id: str
    target_file: str
    diff: str
    snapshot_path: Optional[str]
    status: str  # "staged" | "applied" | "rolled_back" | "blocked" | "failed"
    report: str
    proposed_code: str = ""
    created_at: float = field(default_factory=time.time)


class MutationEngine:
    """Atomic 5-step reversible self-mutation engine with immutable kernel locks."""

    def __init__(
        self,
        base_dir: str = ".",
        snapshots_dir: str = ".raone_snapshots",
        ledger_path: str = ".raone_snapshots/mutations_ledger.json",
    ) -> None:
        self.base_dir = os.path.abspath(base_dir)
        self.snapshots_dir = os.path.abspath(os.path.join(self.base_dir, snapshots_dir))
        self.ledger_path = os.path.abspath(os.path.join(self.base_dir, ledger_path))

    @staticmethod
    def _normalize_rel(target_file: str) -> str:
        return target_file.strip().replace("\\", "/").lstrip("./")

    def is_locked_file(self, target_file: str) -> tuple[bool, str]:
        rel = self._normalize_rel(target_file)
        base_name = os.path.basename(rel)
        if (
            rel in IMMUTABLE_KERNEL_FILES
            or base_name in {"mutation_engine.py", "sandbox.py", ".env", ".env.local"}
            or ".raone_snapshots" in rel
        ):
            return True, f"IMMUTABLE KERNEL LOCK: Modifications to '{rel}' are strictly prohibited."

        abs_target = os.path.abspath(os.path.join(self.base_dir, rel))
        if not abs_target.startswith(self.base_dir + os.sep):
            return True, f"CONTAINMENT FAULT: Path '{rel}' escapes workspace root."

        return False, ""

    def is_live_mutations_enabled(self) -> bool:
        return os.getenv("ALLOW_LIVE_MUTATIONS", "false").strip().lower() == "true"

    def _load_ledger(self) -> list[dict[str, Any]]:
        if not os.path.exists(self.ledger_path):
            return []
        try:
            with open(self.ledger_path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
                return data if isinstance(data, list) else []
        except Exception:
            return []

    def _save_ledger(self, records: list[dict[str, Any]]) -> None:
        os.makedirs(self.snapshots_dir, exist_ok=True)
        with open(self.ledger_path, "w", encoding="utf-8") as handle:
            json.dump(records[-100:], handle, indent=2)

    def snapshots_count(self) -> int:
        if not os.path.exists(self.snapshots_dir):
            return 0
        return sum(1 for f in os.listdir(self.snapshots_dir) if f.endswith(".bak"))

    @staticmethod
    def _check_python_syntax(code: str, target_file: str) -> tuple[bool, str]:
        try:
            ast.parse(code)
        except SyntaxError as exc:
            return False, f"SyntaxError at line {exc.lineno}: {exc.msg}"

        # Reject Python <3.12 f-string expressions containing backslashes
        for match in re.finditer(r'(?:f|fr|rf)["\']{1,3}([\s\S]*?)["\']{1,3}', code):
            for expr in re.findall(r"\{([^{}]+)\}", match.group(1)):
                if "\\" in expr:
                    return False, "SyntaxError (Python <3.12): backslash detected inside f-string expression."

        if target_file.endswith(".py"):
            return True, ""
        return True, ""

    def create_snapshot(self, target_file: str) -> Optional[str]:
        rel = self._normalize_rel(target_file)
        abs_target = os.path.abspath(os.path.join(self.base_dir, rel))
        if not abs_target.startswith(self.base_dir + os.sep):
            return None
        os.makedirs(self.snapshots_dir, exist_ok=True)
        sanitized = re.sub(r"[^a-zA-Z0-9._-]", "_", rel)
        ts = int(time.time() * 1000)
        snap_path = os.path.join(self.snapshots_dir, f"{sanitized}.{ts}.bak")
        if os.path.exists(abs_target):
            with open(abs_target, "r", encoding="utf-8") as src:
                original = src.read()
        else:
            original = "__RAONE_NEW_FILE_MARKER__"
        with open(snap_path, "w", encoding="utf-8") as dst:
            dst.write(original)
        return snap_path

    def stage_and_verify(
        self,
        target_file: str,
        new_code: str,
        test_code: str = "",
    ) -> dict[str, Any]:
        """Steps 1-4: Lock check, snapshot, shadow diff, AST/py_compile syntax check, sandbox verification."""
        rel = self._normalize_rel(target_file)
        locked, lock_reason = self.is_locked_file(rel)
        if locked:
            return {
                "passed": False,
                "blocked": True,
                "mutation_id": "",
                "header": "-- MUTATION BLOCKED --",
                "diff": "",
                "snapshot_path": None,
                "report": lock_reason,
            }

        abs_target = os.path.abspath(os.path.join(self.base_dir, rel))
        existing_lines: list[str] = []
        if os.path.exists(abs_target):
            with open(abs_target, "r", encoding="utf-8") as handle:
                existing_lines = handle.read().splitlines(keepends=True)

        proposed_lines = new_code.splitlines(keepends=True)
        diff_text = "".join(
            difflib.unified_diff(
                existing_lines,
                proposed_lines,
                fromfile=f"a/{rel}",
                tofile=f"b/{rel}",
            )
        )
        header = f"-- MUTATION PIPELINE FOR {rel} --"

        # Step 1: Backup snapshot before touching anything (removed if validation fails)
        snapshot_path = self.create_snapshot(rel)

        # Step 2 & 3: Shadow write + AST / py_compile verification
        if rel.endswith(".py"):
            syntax_ok, syntax_err = self._check_python_syntax(new_code, rel)
            if not syntax_ok:
                if snapshot_path and os.path.exists(snapshot_path):
                    os.remove(snapshot_path)
                return {
                    "passed": False,
                    "blocked": False,
                    "mutation_id": "",
                    "header": header,
                    "diff": diff_text,
                    "snapshot_path": None,
                    "report": f"SIMULATION FAILED: {syntax_err}",
                }

            os.makedirs(os.path.dirname(abs_target), exist_ok=True)
            shadow_path = os.path.join(os.path.dirname(abs_target), f".shadow_{os.path.basename(abs_target)}")
            try:
                with open(shadow_path, "w", encoding="utf-8") as handle:
                    handle.write(new_code)
                check = subprocess.run(
                    [sys.executable, "-m", "py_compile", shadow_path],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if check.returncode != 0:
                    if snapshot_path and os.path.exists(snapshot_path):
                        os.remove(snapshot_path)
                    return {
                        "passed": False,
                        "blocked": False,
                        "mutation_id": "",
                        "header": header,
                        "diff": diff_text,
                        "snapshot_path": None,
                        "report": f"SIMULATION FAILED:\n{check.stderr}",
                    }
            finally:
                if os.path.exists(shadow_path):
                    os.remove(shadow_path)

            # Step 4: Isolated sandbox execution of candidate code (+ optional verification tests)
            combined_test = new_code if not test_code.strip() else f"{new_code}\n\n{test_code}"
            sb_res = run_python_sandbox(combined_test, timeout_seconds=10)
            if not sb_res.success:
                if snapshot_path and os.path.exists(snapshot_path):
                    os.remove(snapshot_path)
                return {
                    "passed": False,
                    "blocked": False,
                    "mutation_id": "",
                    "header": header,
                    "diff": diff_text,
                    "snapshot_path": None,
                    "report": f"SANDBOX VERIFICATION FAILED (exit {sb_res.exit_code}):\n{sb_res.traceback_text}",
                }

        mutation_id = f"mut_{int(time.time() * 1000)}"
        ledger = self._load_ledger()
        ledger.append(
            {
                "mutation_id": mutation_id,
                "target_file": rel,
                "diff": diff_text or new_code,
                "snapshot_path": snapshot_path,
                "proposed_code": new_code,
                "status": "staged",
                "created_at": time.time(),
            }
        )
        self._save_ledger(ledger)

        return {
            "passed": True,
            "blocked": False,
            "mutation_id": mutation_id,
            "header": header,
            "diff": diff_text or new_code,
            "snapshot_path": snapshot_path,
            "report": f"STAGED VERIFICATION PASSED ({mutation_id}) for {rel}.",
        }

    def apply_mutation(self, mutation_id: str, critic_approved: bool = True) -> dict[str, Any]:
        """Step 5: Atomic swap + importlib.reload + auto-rollback on post-swap fault."""
        if not critic_approved:
            return {"ok": False, "error": "Critic approval required before applying mutation."}

        ledger = self._load_ledger()
        target_rec = next((r for r in ledger if r.get("mutation_id") == mutation_id), None)
        if not target_rec:
            return {"ok": False, "error": f"Mutation '{mutation_id}' not found."}

        rel = str(target_rec["target_file"])
        locked, reason = self.is_locked_file(rel)
        if locked:
            return {"ok": False, "error": reason}

        abs_target = os.path.abspath(os.path.join(self.base_dir, rel))
        os.makedirs(os.path.dirname(abs_target), exist_ok=True)
        tmp_path = abs_target + f".tmp_{os.getpid()}"
        proposed_code = str(target_rec.get("proposed_code", ""))
        snap_path = target_rec.get("snapshot_path")

        with open(tmp_path, "w", encoding="utf-8") as handle:
            handle.write(proposed_code)
        os.replace(tmp_path, abs_target)

        # Post-swap import / compile verification
        if rel.endswith(".py"):
            verify = subprocess.run(
                [sys.executable, "-m", "py_compile", abs_target],
                capture_output=True,
                text=True,
                timeout=5,
            )
            mod_name = rel[:-3].replace("/", ".")
            reload_err = ""
            if mod_name in sys.modules:
                try:
                    importlib.reload(sys.modules[mod_name])
                except Exception as exc:
                    reload_err = str(exc)

            if verify.returncode != 0 or reload_err:
                self._restore_from_snapshot(abs_target, snap_path)
                target_rec["status"] = "rolled_back"
                self._save_ledger(ledger)
                return {
                    "ok": False,
                    "rolled_back": True,
                    "error": f"Post-swap fault triggered automatic rollback: {verify.stderr or reload_err}",
                }

        target_rec["status"] = "applied"
        self._save_ledger(ledger)
        return {"ok": True, "mutation_id": mutation_id, "target_file": rel, "status": "applied"}

    @staticmethod
    def _restore_from_snapshot(abs_target: str, snap_path: Optional[str]) -> bool:
        if not snap_path or not os.path.exists(snap_path):
            return False
        with open(snap_path, "r", encoding="utf-8") as src:
            content = src.read()
        if content == "__RAONE_NEW_FILE_MARKER__":
            if os.path.exists(abs_target):
                os.remove(abs_target)
            return True
        tmp_restore = abs_target + ".restore_tmp"
        with open(tmp_restore, "w", encoding="utf-8") as dst:
            dst.write(content)
        os.replace(tmp_restore, abs_target)
        return True

    def rollback_latest(self) -> dict[str, Any]:
        ledger = self._load_ledger()
        for rec in reversed(ledger):
            if rec.get("status") == "applied" and rec.get("snapshot_path"):
                rel = str(rec["target_file"])
                abs_target = os.path.abspath(os.path.join(self.base_dir, rel))
                if not abs_target.startswith(self.base_dir + os.sep):
                    return {"ok": False, "error": "Snapshot target escapes containment."}
                restored = self._restore_from_snapshot(abs_target, rec.get("snapshot_path"))
                if restored:
                    rec["status"] = "rolled_back"
                    self._save_ledger(ledger)
                    return {"ok": True, "mutation_id": rec["mutation_id"], "target_file": rel, "status": "rolled_back"}
        return {"ok": False, "error": "No applied mutation snapshot available to roll back."}
