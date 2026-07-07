"""
Video Emotion Detection API Routes

WebSocket endpoint for real-time emotion detection from webcam video stream.
Processes frames continuously and sends emotion updates back to client.

Session-aware multi-participant pipeline
----------------------------------------
The WebSocket endpoint now accepts three optional query parameters:

  session_id  Identifies which "room" / meeting this camera belongs to.
              Multiple users connecting with the same session_id share one
              EmotionSession and can see aggregated room state + Harmony Score.
              Defaults to "default" (all solo connections share one session).

  user_id     Stable identifier for this participant across reconnects.
              Defaults to "<host>:<port>" derived from the client address.

  is_pov      Boolean (true/false).  When true this participant is designated
              the Point-of-View (deployer) user; their emotion is compared
              against the aggregate room to produce the Harmony Score.
              Defaults to false.

Example WebSocket URL
---------------------
  ws://host/video/emotion?session_id=meeting-42&user_id=alice&is_pov=true
"""

import asyncio
import base64
import json
import time
from asyncio import TimeoutError as AsyncTimeoutError

import cv2
import numpy as np
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, HTTPException, status
from pydantic import BaseModel

from app.config import get_settings
from app.services.coaching_tips import get_coaching_tips
from app.services.insight_generator import get_social_guidance
from app.services.models.hsemotion_detector import HSEmotionDetector
from app.services.session_manager import SessionManager
from app.utils.logging import get_logger

logger = get_logger(__name__)
settings = get_settings()

router = APIRouter(tags=["Video Emotion"])

# Module-level singleton — initialised once, shared across all connections.
_session_mgr = SessionManager.instance()


class FrameAnalysisRequest(BaseModel):
    """Request model for browser frame analysis."""
    image: str  # Base64 encoded image


def _decode_base64_image(base64_str: str) -> np.ndarray:
    """Decode base64 image string to BGR numpy array."""
    # Remove data URL prefix if present
    if "," in base64_str:
        base64_str = base64_str.split(",")[1]
    
    image_bytes = base64.b64decode(base64_str)
    byte_array = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(byte_array, cv2.IMREAD_COLOR)
    
    if image is None:
        raise ValueError("Failed to decode image")
    
    return image


@router.websocket("/video/emotion")
async def video_emotion_websocket(
    websocket: WebSocket,
    session_id: str = Query(default="default"),
    user_id: str = Query(default=""),
    is_pov: bool = Query(default=False),
):
    """
    WebSocket endpoint for real-time, session-aware emotion detection.

    Query parameters
    ----------------
    session_id  Room / meeting identifier (default: "default").
    user_id     Stable participant ID.  Auto-derived from client address if omitted.
    is_pov      True = this camera belongs to the deployer (Point-of-View).

    Every processed frame response includes:
    - Individual emotion result  (unchanged from previous behaviour)
    - spike                      (non-null when a high-intensity change is detected)
    - room                       (aggregated room state + Harmony Score)

    Render-specific optimizations:
    - Handles connection timeouts gracefully
    - Sends keepalive pings to prevent idle timeout
    - Robust error handling for disconnections
    """
    try:
        await websocket.accept()
    except Exception as e:
        logger.error(f"Failed to accept WebSocket connection: {e}")
        return

    # ------------------------------------------------------------------ #
    # Resolve participant identity
    # ------------------------------------------------------------------ #
    # Derive a fallback user_id from the client network address so that
    # solo sessions without an explicit user_id still work correctly.
    if not user_id:
        try:
            client = websocket.client
            user_id = f"{client.host}:{client.port}" if client else "anonymous"
        except Exception:
            user_id = "anonymous"

    # Acquire (or create) the shared session for this room.
    emotion_session = _session_mgr.get_or_create_session(session_id)

    logger.info(
        f"WebSocket connected | session='{session_id}' user='{user_id}' pov={is_pov}"
    )

    # ------------------------------------------------------------------ #
    # Per-connection state
    # ------------------------------------------------------------------ #
    frame_count = 0
    last_emotion = None
    last_confidence = 0.0
    last_ping_time = time.time()
    # Posture state — only populated when ENABLE_BODY_LANGUAGE=true
    last_posture_result: dict | None = None
    _POSTURE_SKIP = 30   # run posture analysis every 30 emotion-frames (~3s at 10fps)

    def is_connected() -> bool:
        try:
            return websocket.client_state.value == 1
        except (AttributeError, ValueError):
            return True

    async def safe_send(data: dict) -> bool:
        if not is_connected():
            return False
        try:
            await websocket.send_json(data)
            return True
        except (WebSocketDisconnect, RuntimeError, ConnectionError) as exc:
            logger.debug(f"WebSocket send failed (client disconnected): {exc}")
            return False
        except Exception as exc:
            logger.error(f"WebSocket send error: {exc}")
            return False

    # ------------------------------------------------------------------ #
    # Main receive / process loop
    # ------------------------------------------------------------------ #
    try:
        if not HSEmotionDetector.is_available():
            await safe_send({"type": "error", "error": "HSEmotion library not available"})
            return

        detector = HSEmotionDetector.instance()

        while True:
            # Keepalive ping every 30 s
            current_time = time.time()
            if current_time - last_ping_time > 30:
                if not await safe_send({"type": "ping"}):
                    break
                last_ping_time = current_time

            # Receive next message (60-second timeout)
            try:
                try:
                    data = await asyncio.wait_for(
                        websocket.receive_text(), timeout=60.0
                    )
                except AsyncTimeoutError:
                    logger.debug("No frame in 60 s — sending keepalive ping")
                    if not await safe_send({"type": "ping"}):
                        break
                    last_ping_time = time.time()
                    continue
            except (WebSocketDisconnect, ConnectionError, RuntimeError) as exc:
                logger.info(f"WebSocket disconnected during receive: {exc}")
                break
            except Exception as exc:
                logger.warning(f"Unexpected receive error: {exc}")
                continue

            # ---------------------------------------------------------- #
            # Parse message
            # ---------------------------------------------------------- #
            try:
                message = json.loads(data)

                # Control messages
                if message.get("type") == "ping":
                    await safe_send({"type": "pong"})
                    last_ping_time = time.time()
                    continue

                if message.get("type") == "stop":
                    logger.info(f"Client '{user_id}' requested stop")
                    break

                # Allow mid-session is_pov override via message field.
                effective_pov = message.get("is_pov", is_pov)

                # -------------------------------------------------- #
                # Test-only: direct emotion vector injection
                # Enabled only when ALLOW_EMOTION_INJECTION=true in .env
                # -------------------------------------------------- #
                if message.get("type") == "inject_emotion":
                    if not settings.ALLOW_EMOTION_INJECTION:
                        await safe_send({
                            "type": "error",
                            "message": (
                                "Emotion injection is disabled. "
                                "Set ALLOW_EMOTION_INJECTION=true in .env to enable it."
                            ),
                        })
                        continue

                    injected: dict = message.get("emotions", {})
                    if not injected:
                        continue

                    spike_event = emotion_session.update_participant(
                        user_id=user_id,
                        emotion_vector=injected,
                        is_pov=effective_pov,
                    )
                    room_state = emotion_session.calculate_weighted_room_state()
                    room_state["social_prompt"] = get_social_guidance(room_state)

                    spike_payload = (
                        {
                            "peak_emotion": spike_event.peak_emotion,
                            "magnitude": spike_event.magnitude,
                            "weight": spike_event.weight,
                        }
                        if spike_event is not None
                        else None
                    )

                    dominant = max(injected.items(), key=lambda kv: kv[1])
                    sent = await safe_send({
                        "type": "emotion",
                        "success": True,
                        "injected": True,           # flag so client knows this is synthetic
                        "emotion": dominant[0],
                        "confidence": round(dominant[1], 3),
                        "emotions": {k: round(v, 3) for k, v in injected.items()},
                        "face_detected": True,
                        "user_id": user_id,
                        "session_id": session_id,
                        "is_pov": effective_pov,
                        "spike": spike_payload,
                        "room": room_state,
                    })
                    if not sent:
                        break
                    continue

                image_data = message.get("image")
                if not image_data:
                    continue

                # Frame-skip for throughput (configurable)
                frame_count += 1
                if frame_count % settings.VIDEO_FRAME_SKIP != 0:
                    continue

                # -------------------------------------------------- #
                # Multi-face emotion inference
                # analyze_faces() returns one dict per detected face,
                # sorted left-to-right.  Falls back gracefully to an
                # empty list when no faces are present.
                # -------------------------------------------------- #
                start_time = time.time()
                image = _decode_base64_image(image_data)
                face_results: list = detector.analyze_faces(image)

                inference_ms = round((time.time() - start_time) * 1000, 1)

                # ── Posture analysis (optional, behind feature flag) ── #
                # Runs every _POSTURE_SKIP emotion-frames to minimise overhead.
                # Failure is silently caught so it never breaks the emotion path.
                if settings.ENABLE_BODY_LANGUAGE and frame_count % _POSTURE_SKIP == 0:
                    try:
                        from app.services.posture_service import PostureDetector
                        if PostureDetector.is_available():
                            last_posture_result = PostureDetector.instance().analyze(image)
                    except Exception as _pe:
                        logger.debug(f"Posture analysis skipped: {_pe}")

                # -------------------------------------------------- #
                # Session manager update — one participant per face
                #
                # Each face gets a stable ID derived from its left-to-
                # right position in the frame so the session manager can
                # track individuals across consecutive frames:
                #   face_0  ← leftmost tile (often the POV / host)
                #   face_1  ← second tile from left
                #   …
                #
                # The connection-level is_pov flag is applied only to
                # face_0 (the POV camera position).  All other faces are
                # treated as non-POV room participants.
                # -------------------------------------------------- #
                any_face_detected = len(face_results) > 0
                last_spike_event = None  # spike from the most recently updated participant

                if any_face_detected:
                    for face in face_results:
                        idx = face["face_index"]
                        face_uid = f"{user_id}_face_{idx}"
                        face_is_pov = effective_pov and (idx == 0)
                        face_spike = emotion_session.update_participant(
                            user_id=face_uid,
                            emotion_vector=face["emotions"],
                            is_pov=face_is_pov,
                        )
                        if face_spike is not None:
                            last_spike_event = face_spike
                else:
                    # No face detected: keep the primary participant's
                    # slot alive with a neutral vector so the session
                    # does not lose track of the connection.
                    neutral_uid = f"{user_id}_face_0"
                    last_spike_event = emotion_session.update_participant(
                        user_id=neutral_uid,
                        emotion_vector={"neutral": 1.0},
                        is_pov=effective_pov,
                    )

                # Room state is cheap (pure arithmetic) — compute every frame.
                room_state = emotion_session.calculate_weighted_room_state()
                room_state["social_prompt"] = get_social_guidance(room_state)

                # Serialise spike info (worst spike this frame, or None).
                spike_payload = (
                    {
                        "peak_emotion": last_spike_event.peak_emotion,
                        "magnitude": last_spike_event.magnitude,
                        "weight": last_spike_event.weight,
                    }
                    if last_spike_event is not None
                    else None
                )

                # -------------------------------------------------- #
                # Build per-face payload for the client
                # Each entry mirrors the old single-face shape so the
                # frontend can stay backward compatible while also
                # gaining the new `faces` array for multi-box drawing.
                # -------------------------------------------------- #
                faces_payload = [
                    {
                        "face_index": f["face_index"],
                        "face_bbox": f["face_bbox"],
                        "emotion": f["emotion"],
                        "confidence": round(f["confidence"], 3),
                        "emotions": {k: round(v, 3) for k, v in f["emotions"].items()},
                        "is_pov": effective_pov and f["face_index"] == 0,
                    }
                    for f in face_results
                ]

                # Primary face (face_0) drives the legacy single-face fields
                # so existing UI code keeps working without changes.
                primary = face_results[0] if face_results else None
                primary_emotion = primary["emotion"] if primary else "neutral"
                primary_confidence = primary["confidence"] if primary else 0.0
                primary_bbox = primary["face_bbox"] if primary else None

                # -------------------------------------------------- #
                # Send response — always send when faces changed or
                # spike occurred; suppress identical quiet frames.
                # -------------------------------------------------- #
                emotion_changed = primary_emotion != last_emotion
                confidence_delta = abs(primary_confidence - last_confidence)
                should_send = (
                    any_face_detected
                    and (
                        emotion_changed
                        or confidence_delta > settings.VIDEO_MIN_CONFIDENCE_DELTA
                        or last_spike_event is not None
                    )
                ) or (not any_face_detected and last_emotion is not None)

                if should_send:
                    last_emotion = primary_emotion if any_face_detected else None
                    last_confidence = primary_confidence

                    _v_reason, _v_suggestion = (
                        get_coaching_tips("video", primary_emotion, primary_confidence)
                        if any_face_detected and primary_emotion
                        else ("", "")
                    )
                    sent = await safe_send({
                        "type": "emotion",
                        "success": any_face_detected,
                        # --- Legacy single-face fields (backward compat) ---
                        "emotion": primary_emotion,
                        "confidence": round(primary_confidence, 3),
                        "emotions": (
                            {k: round(v, 3) for k, v in primary["emotions"].items()}
                            if primary else {}
                        ),
                        "face_detected": any_face_detected,
                        "face_bbox": primary_bbox,
                        # --- NEW: full multi-face array ---
                        "faces": faces_payload,
                        "face_count": len(face_results),
                        "inference_time_ms": inference_ms,
                        # --- Session identity ---
                        "user_id": user_id,
                        "session_id": session_id,
                        "is_pov": effective_pov,
                        # --- Spike (null when none detected) ---
                        "spike": spike_payload,
                        # --- Room aggregate ---
                        "room": room_state,
                        # --- Coaching tips (null when no face / unknown emotion) ---
                        "reason": _v_reason or None,
                        "suggestion": _v_suggestion or None,
                        # --- Body language / posture (null when feature is off) ---
                        "posture_label": (
                            last_posture_result["posture_label"]
                            if last_posture_result else None
                        ),
                        "posture_confidence": (
                            last_posture_result["posture_confidence"]
                            if last_posture_result else None
                        ),
                    })
                    if not sent:
                        break

                    # Quiet periodic checkpoint (in-memory + disk)
                    if frame_count % 120 == 0:
                        _session_mgr.checkpoint_session(session_id, reason="periodic")

            except ValueError as exc:
                logger.debug(f"Frame decode error: {exc}")
                continue
            except json.JSONDecodeError:
                logger.debug("Invalid JSON received")
                continue
            except Exception as exc:
                logger.error(f"Frame processing error: {exc}", exc_info=True)
                if not await safe_send({"type": "error", "message": str(exc)}):
                    break
                continue

    except WebSocketDisconnect:
        logger.info(f"WebSocket client '{user_id}' disconnected")
    except Exception as exc:
        logger.error(f"WebSocket error: {exc}", exc_info=True)
    finally:
        # ---------------------------------------------------------- #
        # Cleanup: remove participant; close session when empty
        # ---------------------------------------------------------- #
        try:
            # Persist room state before tearing down participants (Issue #2).
            if emotion_session.list_participants():
                _session_mgr.checkpoint_session(
                    session_id, reason="client_disconnect"
                )

            # Remove all face-level sub-participants created for this connection.
            # Face IDs follow the pattern "<user_id>_face_<N>".
            detector_ref = HSEmotionDetector.instance() if HSEmotionDetector.is_available() else None
            max_faces = getattr(detector_ref, "MAX_FACES_PER_FRAME", 6) if detector_ref else 6
            for idx in range(max_faces):
                emotion_session.remove_participant(f"{user_id}_face_{idx}")
            # Also attempt to remove the bare user_id (legacy / inject path).
            emotion_session.remove_participant(user_id)
            remaining = emotion_session.list_participants()
            if not remaining:
                _session_mgr.close_session(session_id)
                logger.info(
                    f"Session '{session_id}' closed (all participants disconnected)"
                )
        except Exception as exc:
            logger.warning(f"Cleanup error for '{user_id}': {exc}")

        logger.info(
            f"Video session ended | session='{session_id}' user='{user_id}' "
            f"frames_processed={frame_count}"
        )


@router.post("/video/emotion", summary="Analyze single frame from browser webcam")
async def analyze_browser_frame(request: FrameAnalysisRequest):
    """
    Analyze a single frame from browser webcam.
    Used for polling-based real-time analysis.
    """
    try:
        # Decode image
        image = _decode_base64_image(request.image)
        
        # Analyze emotion
        if not HSEmotionDetector.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="HSEmotion library not available"
            )
        
        detector = HSEmotionDetector.instance()
        result = detector.analyze_image(image)
        
        face_detected = result.get("face_detected", False)
        emotions = result.get("emotions", {}) or {}
        
        if face_detected and emotions:
            emotion = result.get("emotion", "neutral")
            confidence = result.get("confidence", 0.0)
            face_bbox = result.get("face_bbox")
            
            # Convert bbox to list if tuple
            if face_bbox and isinstance(face_bbox, tuple):
                face_bbox = [int(coord) for coord in face_bbox]
            
            return {
                "success": True,
                "emotion": emotion,
                "confidence": round(confidence, 3),
                "emotions": {k: round(v, 3) for k, v in emotions.items()},
                "face_detected": True,
                "face_bbox": face_bbox,
                "aus": {}  # HSEmotion doesn't provide AUs
            }
        else:
            return {
                "success": False,
                "emotion": "neutral",
                "confidence": 0.0,
                "emotions": {},
                "face_detected": False,
                "aus": {}
            }
            
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid image data: {str(e)}"
        )
    except Exception as e:
        logger.error(f"Frame analysis error: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to analyze frame: {str(e)}"
        )


@router.get("/get_realtime_data", summary="Get real-time telemetry data (polling endpoint)")
async def get_realtime_data():
    """
    Polling endpoint for real-time telemetry.
    Returns current emotion state (for server-side video processing).
    """
    # This would be implemented if backend supports server-side video processing
    # For now, return empty state
    return {
        "success": False,
        "emotion": "neutral",
        "confidence": 0.0,
        "emotions": {},
        "face_detected": False,
        "aus": {},
        "message": "Server-side video processing not implemented. Use browser webcam mode."
    }
