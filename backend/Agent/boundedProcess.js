"use strict";

const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

function processError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function spawnBounded(
  executable,
  args,
  {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    spawnImpl = spawn,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { cwd });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let timer = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const consume = (target, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > maxOutputBytes) {
        try { child.kill(); } catch (_) {}
        finish(
          processError(
            "Analysis process exceeded its output limit.",
            "ProcessOutputLimitExceeded",
          ),
        );
        return target;
      }
      return target + buffer.toString();
    };

    child.stdout.on("data", (chunk) => {
      stdout = consume(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = consume(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const error = processError(
          "Analysis process failed.",
          "AnalysisProcessFailed",
        );
        error.exitCode = code;
        error.stderr = stderr.slice(0, 4000);
        finish(error);
      } else {
        finish(null, { stdout, stderr });
      }
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      finish(
        processError(
          "Analysis process exceeded its time limit.",
          "ProcessTimeout",
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  spawnBounded,
};
