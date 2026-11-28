import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface SandboxResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  tracebackText: string;
}

export function runPythonSandbox(code: string, timeoutMs = 10_000): Promise<SandboxResult> {
  return new Promise((resolve) => {
    execFile(
      'python3',
      ['-I', '-c', code],
      { timeout: timeoutMs, maxBuffer: 1024 * 512 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({
            success: true,
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: 0,
            tracebackText: '',
          });
          return;
        }
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        const tb = killed
          ? `ExecutionError: Sandbox subprocess exceeded ${timeoutMs}ms timeout.`
          : stderr || err.message;
        resolve({
          success: false,
          stdout: stdout || '',
          stderr: tb,
          exitCode: typeof err.code === 'number' ? err.code : 1,
          tracebackText: tb,
        });
      }
    );
  });
}

export function computeUnifiedDiff(targetFile: string, oldText: string, newText: string): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const lines: string[] = [`--- a/${targetFile}`, `+++ b/${targetFile}`];
  const maxLen = Math.max(oldLines.length, newLines.length);
  lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);

  for (let i = 0; i < maxLen; i += 1) {
    const a = oldLines[i];
    const b = newLines[i];
    if (a === b) {
      if (a !== undefined) lines.push(` ${a}`);
    } else {
      if (a !== undefined) lines.push(`-${a}`);
      if (b !== undefined) lines.push(`+${b}`);
    }
  }
  return lines.join('\n');
}

export async function simulateMutation(
  targetFile: string,
  newCode: string,
  baseDir = process.cwd()
): Promise<{ passed: boolean; header: string; diff: string; report: string }> {
  const absBase = path.resolve(baseDir);
  const absTarget = path.resolve(absBase, targetFile);
  const header = `-- SIMULATING MUTATION ON ${targetFile} --`;

  if (!absTarget.startsWith(absBase + path.sep)) {
    return {
      passed: false,
      header: '-- MUTATION BLOCKED --',
      diff: '',
      report: 'SYSTEM FAULT: Target path escapes containment boundary.',
    };
  }

  let existing = '';
  try {
    existing = await fs.readFile(absTarget, 'utf-8');
  } catch {
    existing = '';
  }

  const diff = computeUnifiedDiff(targetFile, existing, newCode);

  if (targetFile.endsWith('.py')) {
    const shadowPath = path.join(path.dirname(absTarget), `shadow_${path.basename(absTarget)}`);
    try {
      await fs.mkdir(path.dirname(shadowPath), { recursive: true });
      await fs.writeFile(shadowPath, newCode, 'utf-8');
      const check = await new Promise<{ ok: boolean; err: string }>((resolve) => {
        execFile('python3', ['-m', 'py_compile', shadowPath], { timeout: 5000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, err: stderr || err.message });
          else resolve({ ok: true, err: '' });
        });
      });
      await fs.unlink(shadowPath).catch(() => {});
      if (!check.ok) {
        return {
          passed: false,
          header,
          diff,
          report: `SIMULATION FAILED:\n${check.err}`,
        };
      }
    } catch (err) {
      await fs.unlink(shadowPath).catch(() => {});
      return {
        passed: false,
        header,
        diff,
        report: `SIMULATION CRASH: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else if (targetFile.endsWith('.js') || targetFile.endsWith('.mjs')) {
    const shadowPath = path.join(path.dirname(absTarget), `shadow_${path.basename(absTarget)}`);
    try {
      await fs.mkdir(path.dirname(shadowPath), { recursive: true });
      await fs.writeFile(shadowPath, newCode, 'utf-8');
      const check = await new Promise<{ ok: boolean; err: string }>((resolve) => {
        execFile('node', ['--check', shadowPath], { timeout: 5000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, err: stderr || err.message });
          else resolve({ ok: true, err: '' });
        });
      });
      await fs.unlink(shadowPath).catch(() => {});
      if (!check.ok) {
        return {
          passed: false,
          header,
          diff,
          report: `SIMULATION FAILED:\n${check.err}`,
        };
      }
    } catch (err) {
      await fs.unlink(shadowPath).catch(() => {});
      return {
        passed: false,
        header,
        diff,
        report: `SIMULATION CRASH: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    passed: true,
    header,
    diff,
    report: `SIMULATION SUCCESSFUL. Staged verification passed for ${targetFile}.`,
  };
}
