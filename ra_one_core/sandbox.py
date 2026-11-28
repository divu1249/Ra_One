import ast
import difflib
import os
import subprocess
import sys
from dataclasses import dataclass


@dataclass
class SandboxResult:
    success: bool
    stdout: str
    stderr: str
    exit_code: int
    traceback_text: str


def run_python_sandbox(code: str, timeout_seconds: int = 10) -> SandboxResult:
    """Execute Python code in an isolated subprocess with strict timeout enforcement."""
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        success = completed.returncode == 0
        return SandboxResult(
            success=success,
            stdout=stdout,
            stderr=stderr,
            exit_code=completed.returncode,
            traceback_text=stderr if not success else "",
        )
    except subprocess.TimeoutExpired:
        msg = "ExecutionError: Sandbox subprocess exceeded timeout limit."
        return SandboxResult(success=False, stdout="", stderr=msg, exit_code=124, traceback_text=msg)
    except Exception as exc:
        msg = f"SandboxCrash: {str(exc)}"
        return SandboxResult(success=False, stdout="", stderr=msg, exit_code=1, traceback_text=msg)


def simulate_mutation(target_file: str, new_code: str, base_dir: str = ".") -> dict[str, str | bool]:
    """Pillar 4: Stage shadow syntax/AST verification and generate unified diff before any mutation."""
    abs_base = os.path.abspath(base_dir)
    abs_target = os.path.abspath(os.path.join(abs_base, target_file))

    if not abs_target.startswith(abs_base + os.sep):
        return {
            "passed": False,
            "header": "-- MUTATION BLOCKED --",
            "diff": "",
            "report": "SYSTEM FAULT: Target path escapes containment boundary.",
        }

    existing_lines: list[str] = []
    if os.path.exists(abs_target):
        with open(abs_target, "r", encoding="utf-8") as handle:
            existing_lines = handle.read().splitlines(keepends=True)

    proposed_lines = new_code.splitlines(keepends=True)
    diff_text = "".join(
        difflib.unified_diff(
            existing_lines,
            proposed_lines,
            fromfile=f"a/{target_file}",
            tofile=f"b/{target_file}",
        )
    )

    header = f"-- SIMULATING MUTATION ON {target_file} --"

    if target_file.endswith(".py"):
        try:
            ast.parse(new_code)
        except SyntaxError as exc:
            return {
                "passed": False,
                "header": header,
                "diff": diff_text,
                "report": f"SIMULATION FAILED: SyntaxError at line {exc.lineno}: {exc.msg}",
            }

        shadow_name = f"shadow_{os.path.basename(abs_target)}"
        shadow_path = os.path.join(os.path.dirname(abs_target), shadow_name)
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
                return {
                    "passed": False,
                    "header": header,
                    "diff": diff_text,
                    "report": f"SIMULATION FAILED:\n{check.stderr}",
                }
        finally:
            if os.path.exists(shadow_path):
                os.remove(shadow_path)

    return {
        "passed": True,
        "header": header,
        "diff": diff_text or new_code,
        "report": f"SIMULATION SUCCESSFUL. Staged verification passed for {target_file}.",
    }
