"""Localhost HTTP sidecar for the Mailspring plugin.

Stdlib `http.server` for zero-dependency setup. Endpoints:
    GET  /thread?ids=<msgid1>,<msgid2>,...   → ThreadState as JSON
    POST /score-now    body={"message_ids":[int]}                → run content scorer synchronously
    POST /rate-message body={"message_id":int,"rating":int,"note":str|null,
                             "what_i_saw_on_screen":{"rating":int|null,"cluster_id":int|null},
                             "plugin_version":str|null}          → record Phase 2.5 manual tag
    POST /add-note     body={"message_id":int,"note":str|null}   → set the note on the latest
                                                                    message_ratings row (Ctrl+Cmd+N).
                                                                    Empty/whitespace clears it.
    GET  /healthz                            → service status

All endpoints return 200 OK with nullable fields rather than 4xx/5xx for
missing data. The plugin treats sidecar-down as "no badge" — silent fail.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Empty, Queue
from threading import Event, Lock, Thread
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import (
    __version__, cluster_classifier, config, content_scorer, db, event_creator,
    event_drafter, gcal_oauth, mailspring_intake, manual_rating, notes,
    prompt_refinement, rating_classifier, route_classifier, thread_lookup,
)

log = logging.getLogger(__name__)

# Single-flight lock around content_scorer.score_message_ids — POST /score-now
# is synchronous, but we don't want two concurrent requests both hammering the
# claude CLI from the sidecar.
_SCORE_LOCK = Lock()

# Single-flight lock around mailspring_intake. The plugin fires /intake-now
# every ~5s after a sync burst; concurrent intakes would both lock warehouse.
_INTAKE_LOCK = Lock()

# Counter for new routing_corrections since the last self-refinement run.
# Lock-protected because multiple HTTP worker threads can record corrections
# concurrently. Resets to 0 when refinement fires.
_REFINEMENT_COUNTER_LOCK = Lock()
_NEW_CORRECTIONS_SINCE_REFINEMENT = 0


def _bump_refinement_counter_and_maybe_fire() -> None:
    """Increment the post-correction counter. If it crosses the trigger
    threshold, reset it and spawn a one-shot daemon thread to run
    prompt_refinement.refine(). Idempotent across rapid bursts via the
    refinement module's own file lock."""
    global _NEW_CORRECTIONS_SINCE_REFINEMENT
    fire = False
    with _REFINEMENT_COUNTER_LOCK:
        _NEW_CORRECTIONS_SINCE_REFINEMENT += 1
        if _NEW_CORRECTIONS_SINCE_REFINEMENT >= config.ROUTING_REFINEMENT_TRIGGER_COUNT:
            _NEW_CORRECTIONS_SINCE_REFINEMENT = 0
            fire = True
    if not fire:
        return

    def _run() -> None:
        try:
            with prompt_refinement._RefinementLock():
                log.info("refinement: auto-trigger fired at correction threshold "
                         "%d; calling meta-LLM",
                         config.ROUTING_REFINEMENT_TRIGGER_COUNT)
                result = prompt_refinement.refine(dry_run=False)
                if result.deployed:
                    log.info("refinement: deployed %s (anchors=%d, refinements=%d)",
                             result.new_version_name,
                             result.applied_anchors,
                             result.applied_definition_refinements)
                else:
                    log.info("refinement: no deployment (reason=%s)",
                             result.rejected_reason)
        except RuntimeError as e:
            log.info("refinement: skipped (already running): %s", e)
        except Exception as e:  # noqa: BLE001
            log.exception("refinement: unexpected failure: %s", e)

    t = Thread(target=_run, name="routing-refinement", daemon=True)
    t.start()

# Background routing-classification queue. Producer: /intake-now after a
# successful commit. Consumer: _ROUTING_WORKER thread. Dedupes on insert
# via _ROUTING_SEEN — a single message_id is only ever enqueued once per
# process lifetime.
_ROUTING_QUEUE: "Queue[int]" = Queue()
_ROUTING_SEEN: set[int] = set()
_ROUTING_SEEN_LOCK = Lock()
_ROUTING_STOP = Event()

# Parallel queue + worker for cluster classification (Phase 4.5). Same
# producer (intake) feeds both — a new message gets both a cluster
# classification AND a routing suggestion in the background.
_CLUSTER_QUEUE: "Queue[int]" = Queue()
_CLUSTER_SEEN: set[int] = set()
_CLUSTER_SEEN_LOCK = Lock()

# Phase 6.0 — rating classifier queue + worker. Independent of routing
# and cluster queues; intake fans out to all three.
_RATING_QUEUE: "Queue[int]" = Queue()
_RATING_SEEN: set[int] = set()
_RATING_SEEN_LOCK = Lock()


def _routing_worker() -> None:
    """Pop message_ids off the queue, call suggest_for_message, persist.

    Errors are logged and swallowed — a single bad message must never kill
    the worker. The worker exits cleanly on _ROUTING_STOP set.
    """
    while not _ROUTING_STOP.is_set():
        try:
            mid = _ROUTING_QUEUE.get(timeout=1.0)
        except Empty:
            continue
        try:
            route_classifier.suggest_for_message(mid)
        except Exception as e:  # noqa: BLE001
            log.warning("routing-worker: msg %d failed: %s", mid, e)
        finally:
            _ROUTING_QUEUE.task_done()


def _enqueue_for_classification(message_ids: list[int]) -> int:
    """Add new ids to the routing queue, skipping dupes. Returns count enqueued."""
    added = 0
    with _ROUTING_SEEN_LOCK:
        for mid in message_ids:
            if not isinstance(mid, int):
                continue
            if mid in _ROUTING_SEEN:
                continue
            _ROUTING_SEEN.add(mid)
            _ROUTING_QUEUE.put(mid)
            added += 1
    return added


def _cluster_worker() -> None:
    """Pop message_ids off the cluster queue and run cluster classification.
    Errors are logged and swallowed; the worker exits on _ROUTING_STOP."""
    while not _ROUTING_STOP.is_set():
        try:
            mid = _CLUSTER_QUEUE.get(timeout=1.0)
        except Empty:
            continue
        try:
            cluster_classifier.classify_message(mid)
        except Exception as e:  # noqa: BLE001
            log.warning("cluster-worker: msg %d failed: %s", mid, e)
        finally:
            _CLUSTER_QUEUE.task_done()


def _enqueue_for_cluster_classification(message_ids: list[int]) -> int:
    added = 0
    with _CLUSTER_SEEN_LOCK:
        for mid in message_ids:
            if not isinstance(mid, int):
                continue
            if mid in _CLUSTER_SEEN:
                continue
            _CLUSTER_SEEN.add(mid)
            _CLUSTER_QUEUE.put(mid)
            added += 1
    return added


def _rating_worker() -> None:
    """Pop message_ids off the rating queue and call the rating classifier.
    Errors are logged and swallowed; the worker exits on _ROUTING_STOP."""
    while not _ROUTING_STOP.is_set():
        try:
            mid = _RATING_QUEUE.get(timeout=1.0)
        except Empty:
            continue
        try:
            rating_classifier.suggest_for_message(mid)
        except Exception as e:  # noqa: BLE001
            log.warning("rating-worker: msg %d failed: %s", mid, e)
        finally:
            _RATING_QUEUE.task_done()


def _enqueue_for_rating_classification(message_ids: list[int]) -> int:
    added = 0
    with _RATING_SEEN_LOCK:
        for mid in message_ids:
            if not isinstance(mid, int):
                continue
            if mid in _RATING_SEEN:
                continue
            _RATING_SEEN.add(mid)
            _RATING_QUEUE.put(mid)
            added += 1
    return added


class Handler(BaseHTTPRequestHandler):
    server_version = f"mml-classifier/{__version__}"

    # Quiet the default per-request stderr line; we'll log via logging.
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401
        log.info("%s - %s", self.address_string(), fmt % args)

    # ---- Routing ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 — stdlib API
        url = urlsplit(self.path)
        if url.path == "/thread":
            return self._handle_thread(parse_qs(url.query))
        if url.path == "/healthz":
            return self._handle_healthz()
        self._send_json(404, {"error": "not found", "path": url.path})

    def do_POST(self) -> None:  # noqa: N802
        url = urlsplit(self.path)
        if url.path == "/score-now":
            return self._handle_score_now()
        if url.path == "/rate-message":
            return self._handle_rate_message()
        if url.path == "/add-note":
            return self._handle_add_note()
        if url.path == "/draft-event":
            return self._handle_draft_event()
        if url.path == "/create-event":
            return self._handle_create_event()
        if url.path == "/route-suggest":
            return self._handle_route_suggest()
        if url.path == "/route-correction":
            return self._handle_route_correction()
        if url.path == "/intake-now":
            return self._handle_intake_now()
        if url.path == "/rating-suggest":
            return self._handle_rating_suggest()
        self._send_json(404, {"error": "not found", "path": url.path})

    # ---- Handlers ---------------------------------------------------------

    def _handle_thread(self, params: dict[str, list[str]]) -> None:
        raw = (params.get("ids") or [""])[0]
        ids = [m for m in (s.strip() for s in raw.split(",")) if m]
        if not ids:
            self._send_json(200, thread_lookup._empty_state().to_dict())
            return
        try:
            state = thread_lookup.resolve_thread(ids)
        except Exception as e:  # noqa: BLE001
            log.exception("/thread failed for ids=%r", ids)
            self._send_json(200, {**thread_lookup._empty_state().to_dict(),
                                  "error": str(e)})
            return
        self._send_json(200, state.to_dict())

    def _handle_score_now(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
            message_ids = payload.get("message_ids") or []
            if not isinstance(message_ids, list) or not all(
                isinstance(m, int) for m in message_ids
            ):
                self._send_json(200, {"scored": 0, "skipped": 0,
                                      "errors": ["message_ids must be list[int]"]})
                return
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(200, {"scored": 0, "skipped": 0, "errors": [str(e)]})
            return

        if not _SCORE_LOCK.acquire(blocking=False):
            self._send_json(200, {"scored": 0, "skipped": len(message_ids),
                                  "errors": ["scorer busy"]})
            return
        try:
            stats = content_scorer.score_message_ids(message_ids)
        finally:
            _SCORE_LOCK.release()

        self._send_json(200, {
            "scored": stats.scored,
            "skipped": stats.skipped,
            "errors": [] if stats.errors == 0 else [f"{stats.errors} scoring errors"],
        })

    def _handle_rate_message(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(200, {
                "rating_id": None, "rated_at": None, "contact_email": None,
                "contact_rating_updated": False, "error": f"invalid json: {e}",
            })
            return

        message_id = payload.get("message_id")
        rfc_message_id = payload.get("rfc_message_id")
        rating = payload.get("rating")
        note = payload.get("note")
        snapshot = payload.get("what_i_saw_on_screen") or {}
        plugin_version = payload.get("plugin_version")

        try:
            result = manual_rating.record_tag(
                message_id=message_id if isinstance(message_id, int) else None,
                rfc_message_id=rfc_message_id if isinstance(rfc_message_id, str) else None,
                rating=rating,
                note=note,
                snapshot=snapshot,
                plugin_version=plugin_version,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("/rate-message failed for payload=%r", payload)
            self._send_json(200, {
                "rating_id": None, "rated_at": None, "contact_email": None,
                "contact_rating_updated": False, "error": str(e),
            })
            return

        self._send_json(200, result.to_dict())

    def _handle_add_note(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(200, {
                "rating_id": None, "note": None,
                "error": f"invalid json: {e}",
            })
            return

        message_id = payload.get("message_id")
        rfc_message_id = payload.get("rfc_message_id")
        note = payload.get("note")

        if not isinstance(message_id, int) and not isinstance(rfc_message_id, str):
            self._send_json(200, {
                "rating_id": None, "note": None,
                "error": "must supply message_id (int) or rfc_message_id (str)",
            })
            return
        if note is not None and not isinstance(note, str):
            self._send_json(200, {
                "rating_id": None, "note": None,
                "error": "note must be string or null",
            })
            return

        try:
            result = notes.add_note(
                message_id=message_id if isinstance(message_id, int) else None,
                rfc_message_id=rfc_message_id if isinstance(rfc_message_id, str) else None,
                note=note,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("/add-note failed for payload=%r", payload)
            self._send_json(200, {
                "rating_id": None, "note": None, "error": str(e),
            })
            return

        self._send_json(200, result.to_dict())

    def _handle_draft_event(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(200, {
                "source_message_id": None, "title": None, "description": None,
                "proposed_start_iso": None, "duration_minutes": None,
                "attendees": [], "confidence": None,
                "error": f"invalid json: {e}",
            })
            return

        message_id = payload.get("message_id")
        rfc_message_id = payload.get("rfc_message_id")

        if not isinstance(message_id, int) and not isinstance(rfc_message_id, str):
            self._send_json(200, {
                "source_message_id": None, "title": None, "description": None,
                "proposed_start_iso": None, "duration_minutes": None,
                "attendees": [], "confidence": None,
                "error": "must supply message_id (int) or rfc_message_id (str)",
            })
            return

        try:
            result = event_drafter.draft_event(
                message_id=message_id if isinstance(message_id, int) else None,
                rfc_message_id=rfc_message_id if isinstance(rfc_message_id, str) else None,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("/draft-event failed for payload=%r", payload)
            self._send_json(200, {
                "source_message_id": None, "title": None, "description": None,
                "proposed_start_iso": None, "duration_minutes": None,
                "attendees": [], "confidence": None,
                "error": str(e),
            })
            return

        self._send_json(200, result.to_dict())

    def _handle_create_event(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(200, {
                "calendar_event_id": None, "gcal_event_id": None,
                "html_link": None, "title": None,
                "start_iso": None, "end_iso": None,
                "error": f"invalid json: {e}",
            })
            return

        try:
            result = event_creator.create_event(payload)
        except Exception as e:  # noqa: BLE001
            log.exception("/create-event failed for payload=%r", payload)
            self._send_json(200, {
                "calendar_event_id": None, "gcal_event_id": None,
                "html_link": None, "title": None,
                "start_iso": None, "end_iso": None,
                "error": str(e),
            })
            return

        self._send_json(200, result.to_dict())

    def _handle_route_suggest(self) -> None:
        """POST /route-suggest body={"message_id": int} OR {"rfc_message_id": str}

        Returns the cached suggestion at the current classifier_version, or
        fires a fresh LLM call and persists. Returns an empty suggestion with
        a non-null `error` on failure rather than 4xx/5xx.
        """
        empty = route_classifier._empty_suggestion()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(200, {**empty, "error": f"invalid json: {e}"})
            return

        message_id = payload.get("message_id")
        rfc_message_id = payload.get("rfc_message_id")

        if isinstance(message_id, int):
            resolved_id: int | None = message_id
        elif isinstance(rfc_message_id, str) and rfc_message_id.strip():
            with db.read_only() as con:
                resolved_id = db.resolve_message_pk(rfc_message_id, con)
        else:
            self._send_json(200, {**empty,
                                  "error": "must supply message_id (int) or rfc_message_id (str)"})
            return

        if resolved_id is None:
            self._send_json(200, {**empty, "error": "message not found in warehouse"})
            return

        cached_only = bool(payload.get("cached_only"))
        try:
            suggestion = route_classifier.suggest_for_message(
                resolved_id, cached_only=cached_only,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("/route-suggest failed for message_id=%s", resolved_id)
            self._send_json(200, {**empty, "message_id": resolved_id, "error": str(e)})
            return

        if suggestion is None:
            self._send_json(200, {**empty, "message_id": resolved_id,
                                  "error": ("not yet classified"
                                            if cached_only else "message not found")})
            return
        self._send_json(200, suggestion.to_dict())

    def _handle_route_correction(self) -> None:
        """POST /route-correction
            body={"message_id": int | "rfc_message_id": str,
                  "suggested_folder": str|null,
                  "accepted_folder": str,
                  "source": "accept"|"override"|"manual",
                  "plugin_version": str|null}
        """
        empty = {"correction_id": None, "decided_at": None, "source": None}
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(200, {**empty, "error": f"invalid json: {e}"})
            return

        message_id = payload.get("message_id")
        rfc_message_id = payload.get("rfc_message_id")
        if isinstance(message_id, int):
            resolved_id: int | None = message_id
        elif isinstance(rfc_message_id, str) and rfc_message_id.strip():
            with db.read_only() as con:
                resolved_id = db.resolve_message_pk(rfc_message_id, con)
        else:
            self._send_json(200, {**empty,
                                  "error": "must supply message_id (int) or rfc_message_id (str)"})
            return

        if resolved_id is None:
            self._send_json(200, {**empty, "error": "message not found in warehouse"})
            return

        suggested_folder = payload.get("suggested_folder")
        accepted_folder = payload.get("accepted_folder")
        source = payload.get("source")
        plugin_version = payload.get("plugin_version")

        if not isinstance(accepted_folder, str) or not accepted_folder:
            self._send_json(200, {**empty,
                                  "error": "accepted_folder must be a non-empty string"})
            return
        if source not in ("accept", "override", "manual"):
            self._send_json(200, {**empty,
                                  "error": "source must be one of accept|override|manual"})
            return

        classifier_version: str | None = None
        if suggested_folder is not None:
            classifier_version = config.ROUTING_CLASSIFIER_VERSION

        try:
            result = route_classifier.record_correction(
                message_id=resolved_id,
                suggested_folder=(suggested_folder
                                  if isinstance(suggested_folder, str) else None),
                accepted_folder=accepted_folder,
                source=source,
                plugin_version=(plugin_version
                                if isinstance(plugin_version, str) else None),
                classifier_version=classifier_version,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("/route-correction failed for payload=%r", payload)
            self._send_json(200, {**empty, "error": str(e)})
            return

        # Phase 5.5.5 — bump the auto-refinement counter; fire if threshold hit.
        try:
            _bump_refinement_counter_and_maybe_fire()
        except Exception as e:  # noqa: BLE001
            log.warning("refinement counter bump failed: %s", e)

        self._send_json(200, {**result.to_dict(), "message_id": resolved_id})

    def _handle_rating_suggest(self) -> None:
        """POST /rating-suggest body={"message_id": int} OR {"rfc_message_id": str}
                                       [, "cached_only": bool]
        Returns the suggested 0-9 rating + reason + confidence."""
        empty = rating_classifier._empty_suggestion()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw or "{}")
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json(200, {**empty, "error": f"invalid json: {e}"})
            return

        message_id = payload.get("message_id")
        rfc_message_id = payload.get("rfc_message_id")
        if isinstance(message_id, int):
            resolved_id: int | None = message_id
        elif isinstance(rfc_message_id, str) and rfc_message_id.strip():
            with db.read_only() as con:
                resolved_id = db.resolve_message_pk(rfc_message_id, con)
        else:
            self._send_json(200, {**empty,
                                  "error": "must supply message_id (int) or rfc_message_id (str)"})
            return
        if resolved_id is None:
            self._send_json(200, {**empty, "error": "message not found in warehouse"})
            return

        cached_only = bool(payload.get("cached_only"))
        try:
            suggestion = rating_classifier.suggest_for_message(
                resolved_id, cached_only=cached_only,
            )
        except Exception as e:  # noqa: BLE001
            log.exception("/rating-suggest failed for message_id=%s", resolved_id)
            self._send_json(200, {**empty, "message_id": resolved_id, "error": str(e)})
            return
        if suggestion is None:
            self._send_json(200, {**empty, "message_id": resolved_id,
                                  "error": ("not yet classified"
                                            if cached_only else "message not found")})
            return
        self._send_json(200, suggestion.to_dict())

    def _handle_intake_now(self) -> None:
        """POST /intake-now (body ignored)

        Runs an incremental Mailspring → warehouse intake. No APFS backup —
        this endpoint fires on every Mailspring sync burst (plugin-triggered)
        and a backup-per-burst is overkill. Intake itself is append-only
        and skips messages whose RFC-822 ID already exists in warehouse.

        Single-flight: concurrent calls return {busy:true, ...} immediately
        rather than queueing behind warehouse-locking work.
        """
        empty = {
            "messages_inserted": 0,
            "recipients_inserted": 0,
            "contacts_inserted": 0,
            "folders_inserted": 0,
            "skipped_already_present": 0,
            "busy": False,
        }
        if not _INTAKE_LOCK.acquire(blocking=False):
            self._send_json(200, {**empty, "busy": True})
            return
        try:
            edgehill_db = mailspring_intake.DEFAULT_EDGEHILL_DB
            if not edgehill_db.exists():
                self._send_json(200, {**empty,
                                      "error": f"edgehill.db not found at {edgehill_db}"})
                return
            plan = mailspring_intake.build_plan(edgehill_db,
                                                since_iso=None, limit=None)
            if not plan.new_messages:
                self._send_json(200, {**empty,
                                      "skipped_already_present": plan.skipped_already_present})
                return
            stats = mailspring_intake.commit_plan(plan, edgehill_db)

            # Enqueue the freshly-inserted messages for background routing
            # classification so the cache is warm by the time the user looks.
            new_ids: list[int] = []
            try:
                # commit_plan inserts in the order plan.new_messages provides.
                # Resolve the most recent N=messages_inserted rows from warehouse
                # to get their primary keys without changing the intake API.
                with db.read_only() as con:
                    rows = con.execute(
                        "SELECT id FROM messages ORDER BY id DESC LIMIT ?",
                        (stats.messages_inserted,),
                    ).fetchall()
                new_ids = [int(r["id"]) for r in rows]
            except Exception as e:  # noqa: BLE001
                log.warning("intake: couldn't resolve new ids for classification: %s", e)
            enqueued = _enqueue_for_classification(new_ids)
            cluster_enqueued = _enqueue_for_cluster_classification(new_ids)
            rating_enqueued = _enqueue_for_rating_classification(new_ids)
            if enqueued or cluster_enqueued or rating_enqueued:
                log.info("intake: enqueued %d msgs for routing, %d for cluster, %d for rating",
                         enqueued, cluster_enqueued, rating_enqueued)

            self._send_json(200, {
                "messages_inserted": stats.messages_inserted,
                "recipients_inserted": stats.recipients_inserted,
                "contacts_inserted": stats.contacts_inserted,
                "folders_inserted": stats.folders_inserted,
                "skipped_already_present": plan.skipped_already_present,
                "classification_enqueued": enqueued,
                "cluster_classification_enqueued": cluster_enqueued,
                "rating_classification_enqueued": rating_enqueued,
                "busy": False,
            })
        except Exception as e:  # noqa: BLE001
            log.exception("/intake-now failed")
            self._send_json(200, {**empty, "error": str(e)})
        finally:
            _INTAKE_LOCK.release()

    def _handle_healthz(self) -> None:
        last_score_at: str | None = None
        try:
            with db.read_only() as con:
                row = con.execute(
                    "SELECT MAX(scored_at) AS s FROM content_scores"
                ).fetchone()
                if row:
                    last_score_at = row["s"]
        except Exception as e:  # noqa: BLE001
            log.warning("healthz: warehouse read failed: %s", e)

        cli_ok = shutil.which(config.CLAUDE_CLI) is not None
        cli_version: str | None = None
        if cli_ok:
            try:
                proc = subprocess.run(
                    [config.CLAUDE_CLI, "--version"],
                    capture_output=True, text=True, timeout=5, check=False,
                )
                cli_version = (proc.stdout or proc.stderr).strip().splitlines()[0]
            except (subprocess.TimeoutExpired, OSError) as e:
                log.warning("healthz: claude --version failed: %s", e)
                cli_ok = False

        self._send_json(200, {
            "version": __version__,
            "scorer_version": config.SCORER_VERSION,
            "ingester_version": config.INGESTER_VERSION,
            "warehouse_db": str(config.WAREHOUSE_DB),
            "last_score_at": last_score_at,
            "claude_cli_ok": cli_ok,
            "claude_cli_version": cli_version,
            "gcal": gcal_oauth.credentials_status(),
        })

    # ---- Helpers ----------------------------------------------------------

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


def serve(host: str = config.HOST, port: int = config.PORT) -> None:
    server = ThreadingHTTPServer((host, port), Handler)

    # Start the routing classifier worker. Daemon thread so it exits with
    # the process; clean stop also signaled via _ROUTING_STOP on shutdown.
    worker = Thread(target=_routing_worker, name="routing-worker", daemon=True)
    worker.start()
    log.info("routing-worker started (background classification queue).")

    # Phase 4.5 — parallel cluster classifier worker.
    cluster_worker = Thread(target=_cluster_worker, name="cluster-worker", daemon=True)
    cluster_worker.start()
    log.info("cluster-worker started (background 38-cluster classification queue).")

    # Phase 6.0 — parallel rating classifier worker.
    rating_worker = Thread(target=_rating_worker, name="rating-worker", daemon=True)
    rating_worker.start()
    log.info("rating-worker started (background 0-9 rating classification queue).")

    log.info("mml-classifier listening on http://%s:%d (warehouse=%s)",
             host, port, config.WAREHOUSE_DB)
    try:
        server.serve_forever()
    finally:
        _ROUTING_STOP.set()


def main() -> None:
    ap = argparse.ArgumentParser(description="mml-classifier sidecar HTTP server")
    ap.add_argument("--host", default=config.HOST)
    ap.add_argument("--port", type=int, default=config.PORT)
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = ap.parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    )
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
