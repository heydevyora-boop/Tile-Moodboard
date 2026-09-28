"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runPythonScript = runPythonScript;
exports.parseResultLine = parseResultLine;
const child_process_1 = require("child_process");
const index_1 = require("@config/index");
const logger_1 = require("@utils/logger");
const AppError_1 = require("@utils/AppError");
function runPythonScript({ script, args = [], onLine, timeoutMs = 6 * 60 * 60 * 1000 }) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(index_1.config.python.executable, [script, ...args], {
            cwd: index_1.config.python.scriptsDir,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(AppError_1.AppError.internal(`Python script "${script}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            text
                .split('\n')
                .filter(Boolean)
                .forEach((line) => {
                logger_1.logger.debug(`[python:${script}] ${line}`);
                onLine?.(line);
            });
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(AppError_1.AppError.internal(`Failed to start Python script "${script}": ${err.message}`));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                logger_1.logger.warn(`Python script "${script}" exited with code ${code}`, { stderr: stderr.slice(-2000) });
            }
            resolve({ stdout, stderr, exitCode: code });
        });
    });
}
function parseResultLine(stdout, prefix) {
    const lines = stdout.split('\n').filter((l) => l.startsWith(prefix));
    const last = lines[lines.length - 1];
    if (!last) {
        throw AppError_1.AppError.internal(`Python script did not print a "${prefix}" result line`);
    }
    const jsonText = last.slice(prefix.length).trim();
    try {
        return JSON.parse(jsonText);
    }
    catch {
        throw AppError_1.AppError.internal(`Python script's "${prefix}" line was not valid JSON: ${jsonText.slice(0, 500)}`);
    }
}
//# sourceMappingURL=pythonRunner.js.map