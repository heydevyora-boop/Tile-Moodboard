import { spawn } from 'child_process';
import { config } from '@config/index';
import { logger } from '@utils/logger';
import { AppError } from '@utils/AppError';

interface RunPythonOptions {
  /** Script filename inside PYTHON_SCRIPTS_DIR, e.g. "extract.py" */
  script: string;
  /** CLI args passed to the script */
  args?: string[];
  /** Called with each stdout line as it streams in — useful for progress bars / SSE */
  onLine?: (line: string) => void;
  timeoutMs?: number;
}

export interface PythonRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Runs a Python script from the python/ directory as a child process and
 * resolves with its full stdout/stderr/exit code — regardless of whether
 * the exit code was 0.
 *
 * This is deliberate: scripts like extract.py report failure via a JSON
 * payload printed to stdout (e.g. `RESULT_JSON: {"success": false, ...}`)
 * even when they exit non-zero, so the caller needs that stdout either
 * way to get the actual error detail. Only a failure to start the
 * process at all, or a timeout, rejects the promise — a script running
 * to completion and reporting its own failure is not, from this
 * function's point of view, a failure to run the script.
 *
 * This is the bridge the build guide's Part 1 (Catalog Extractor,
 * extract.py) relies on: the frontend's "Run Extractor" button hits an
 * Express endpoint, which calls this to kick off the long-running Python
 * job and streams progress back.
 */
export function runPythonScript({ script, args = [], onLine, timeoutMs = 6 * 60 * 60 * 1000 }: RunPythonOptions): Promise<PythonRunResult> {
  return new Promise((resolve, reject) => {
    // cwd is set to scriptsDir below, so the spawned arg must be just the
    // bare script name — joining scriptsDir into the path here too would
    // double-apply it (e.g. "python/extract.py" run with cwd "python/"
    // resolves to "python/python/extract.py", which doesn't exist).
    const child = spawn(config.python.executable, [script, ...args], {
      cwd: config.python.scriptsDir,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(AppError.internal(`Python script "${script}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      text
        .split('\n')
        .filter(Boolean)
        .forEach((line) => {
          logger.debug(`[python:${script}] ${line}`);
          onLine?.(line);
        });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(AppError.internal(`Failed to start Python script "${script}": ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn(`Python script "${script}" exited with code ${code}`, { stderr: stderr.slice(-2000) });
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Pulls the last `PREFIX: {...}` line out of a script's stdout and parses
 * it as JSON. Scripts print free-form progress lines throughout, with
 * exactly one machine-readable result line at the end — this finds it
 * without caring about anything else on stdout.
 */
export function parseResultLine<T>(stdout: string, prefix: string): T {
  const lines = stdout.split('\n').filter((l) => l.startsWith(prefix));
  const last = lines[lines.length - 1];
  if (!last) {
    throw AppError.internal(`Python script did not print a "${prefix}" result line`);
  }
  const jsonText = last.slice(prefix.length).trim();
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    throw AppError.internal(`Python script's "${prefix}" line was not valid JSON: ${jsonText.slice(0, 500)}`);
  }
}
