"""Thin subprocess wrapper around the `claude` CLI.

Invokes `claude --print --output-format json --no-session-persistence
--disable-slash-commands` so mail-scoring runs don't pollute the owner's
interactive session history or load skills they don't need.

We deliberately do NOT pass `--bare`: that flag forces auth via
ANTHROPIC_API_KEY only (OAuth/keychain are skipped), but the working system
runs the CLI under Claude Max OAuth. Without `--bare` the CLI loads the default system
prompt + CLAUDE.md + plugin sync, which costs ~105k cache_creation tokens
(~$0.13) on the first call of an hour and pennies after that thanks to the
1-hour ephemeral cache. For one-time historical backfill, switch to the
Anthropic API directly.

Public API:
    call(prompt, *, system, json_schema=None, model=None) -> dict
        — returns the parsed JSON result (validated against json_schema if given).
    smoke_main()
        — CLI entrypoint: `python -m mml_classifier.claude_cli --smoke`.
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from typing import Any

from . import config

log = logging.getLogger(__name__)


class ClaudeCallError(RuntimeError):
    pass


def call(
    prompt: str,
    *,
    system: str,
    json_schema: dict | None = None,
    model: str | None = None,
    max_retries: int | None = None,
    timeout: int | None = None,
) -> dict[str, Any]:
    """Run `claude` with the given prompt + system prompt; return parsed JSON.

    Retries on transient failures (non-zero exit + empty stdout, or invalid JSON)
    with exponential backoff. Raises ClaudeCallError after exhausting retries.
    """
    cmd: list[str] = [
        config.CLAUDE_CLI,
        "--print",
        "--output-format", "json",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--model", model or config.CLAUDE_MODEL,
        "--system-prompt", system,
    ]
    if json_schema is not None:
        cmd += ["--json-schema", json.dumps(json_schema)]
    cmd.append(prompt)

    attempts = (max_retries if max_retries is not None else config.CLAUDE_MAX_RETRIES) + 1
    timeout_s = timeout or config.CLAUDE_TIMEOUT_SECONDS

    last_err: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            last_err = e
            log.warning("claude CLI timed out (attempt %d/%d)", attempt, attempts)
        else:
            if proc.returncode == 0 and proc.stdout.strip():
                try:
                    envelope = json.loads(proc.stdout)
                except json.JSONDecodeError as e:
                    last_err = e
                    log.warning("claude CLI returned non-JSON (attempt %d/%d): %s",
                                attempt, attempts, proc.stdout[:200])
                else:
                    # The CLI's --output-format=json wraps the assistant's
                    # response in an envelope. The actual model output lives
                    # under `result` (string) when --json-schema is unset, or
                    # is a dict already when --json-schema validated it.
                    return _unwrap(envelope, json_schema is not None)
            else:
                last_err = ClaudeCallError(
                    f"claude exit={proc.returncode} stderr={proc.stderr[:300]!r}"
                )
                log.warning("claude CLI failed (attempt %d/%d): %s",
                            attempt, attempts, last_err)

        if attempt < attempts:
            time.sleep(2 ** attempt)

    raise ClaudeCallError(f"claude CLI failed after {attempts} attempts: {last_err}")


def _unwrap(envelope: dict, schema_used: bool) -> dict[str, Any]:
    """Extract the model's structured output from the CLI envelope.

    With `--json-schema` the CLI produces a `structured_output` dict and an
    empty `result` string. Without it, the assistant's JSON-only reply lives
    in `result` as a string we re-parse.
    """
    if schema_used:
        so = envelope.get("structured_output")
        if isinstance(so, dict):
            return so
        # Some CLI versions may not validate; fall through to result parsing.

    result = envelope.get("result")
    if isinstance(result, dict):
        return result
    if isinstance(result, str) and result.strip():
        try:
            return json.loads(result)
        except json.JSONDecodeError as e:
            raise ClaudeCallError(
                f"claude returned non-JSON in `result`: {result[:200]!r} ({e})"
            ) from e

    raise ClaudeCallError(
        f"claude returned no usable output (schema_used={schema_used}); "
        f"envelope keys={list(envelope.keys())[:10]}"
    )


# ---- Smoke entrypoint -------------------------------------------------------

_SMOKE_SYSTEM = (
    "You return strict JSON only. No prose. No code fences. "
    "Schema: {\"hello\": <string>}. Always include exactly that key."
)
_SMOKE_PROMPT = "Say hi."
_SMOKE_SCHEMA = {
    "type": "object",
    "properties": {"hello": {"type": "string"}},
    "required": ["hello"],
    "additionalProperties": False,
}


def smoke_main() -> None:
    ap = argparse.ArgumentParser(description="Smoke-test the claude CLI wrapper.")
    ap.add_argument("--smoke", action="store_true",
                    help="(default action; flag retained for clarity)")
    ap.add_argument("--no-schema", action="store_true",
                    help="Run without --json-schema validation.")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")

    print(f"claude_cli config: cli={config.CLAUDE_CLI} model={config.CLAUDE_MODEL}")
    print(f"calling claude...")
    out = call(
        _SMOKE_PROMPT,
        system=_SMOKE_SYSTEM,
        json_schema=None if args.no_schema else _SMOKE_SCHEMA,
        max_retries=1,
    )
    print(f"OK. parsed JSON: {json.dumps(out, indent=2)}")
    if "hello" in out:
        print(f"smoke PASS — model said: {out['hello']!r}")
    else:
        print("smoke WARN — response missing 'hello' key", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    smoke_main()
