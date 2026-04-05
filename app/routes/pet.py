"""
Pet (Cat/Dog) Detection API Routes

REST endpoint: POST /pet/detect — upload an image, receive bounding boxes.
WebSocket endpoint: WS /pet/detect/live — stream base64 webcam frames,
    receive real-time pet detections.

Does NOT touch HSEmotion or Groq Audio logic.
"""

import asyncio
import base64
import json
import time
from asyncio import TimeoutError as AsyncTimeoutError

import cv2
import numpy as np
from fastapi import APIRouter, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect, status

from app.models.schemas import PetDetection, PetDetectionResponse
from app.services.models.yolo_detector import YOLOPetDetector
from app.utils.logging import get_logger, get_request_id
from app.utils.metrics import get_metrics

logger = get_logger(__name__)

router = APIRouter(tags=["Pet Detection"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _decode_image_bytes(image_bytes: bytes) -> np.ndarray:
    """Decode raw bytes → BGR numpy array (OpenCV format)."""
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Failed to decode image — unsupported format or corrupted file")
    return img


def _decode_base64_image(b64: str) -> np.ndarray:
    """Decode a data-URL or plain base64 string → BGR numpy array."""
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    raw = base64.b64decode(b64)
    return _decode_image_bytes(raw)


async def _validate_and_read_image(file: UploadFile) -> bytes:
    """Validate content-type / extension and return raw bytes."""
    filename = file.filename or "unknown"
    content_type = file.content_type or ""

    allowed_types = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
    allowed_exts = {".jpg", ".jpeg", ".png", ".webp"}

    if content_type not in allowed_types:
        if not any(filename.lower().endswith(ext) for ext in allowed_exts):
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="Unsupported file type. Please upload JPG, PNG, or WebP.",
            )

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file uploaded",
        )
    return image_bytes


# ---------------------------------------------------------------------------
# REST: POST /pet/detect
# ---------------------------------------------------------------------------

@router.post(
    "/pet/detect",
    response_model=PetDetectionResponse,
    summary="Detect cats/dogs in an uploaded image",
)
async def pet_detect(file: UploadFile = File(...)) -> PetDetectionResponse:
    """
    Detect cats and dogs in an uploaded image using YOLOv8n/YOLO11n.

    Returns bounding boxes, labels, and confidence scores for every pet found.
    Returns success=False with an empty detections list when no pets are detected.
    """
    filename = file.filename or "unknown"
    request_id = get_request_id() or "unknown"

    try:
        if not YOLOPetDetector.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="YOLO pet detector not available. Install ultralytics.",
            )

        logger.info(f"[{request_id}] Pet detection request: filename='{filename}'")

        image_bytes = await _validate_and_read_image(file)
        image = _decode_image_bytes(image_bytes)

        start = time.time()
        detector = YOLOPetDetector.instance()
        raw = detector.detect(image)
        elapsed_ms = (time.time() - start) * 1000
        get_metrics().record_model_inference(elapsed_ms)

        detections = [PetDetection(**d) for d in raw]
        success = len(detections) > 0

        if success:
            labels = ", ".join(d.label for d in detections)
            logger.info(
                f"[{request_id}] ✅ Pet detection completed | "
                f"found={len(detections)} ({labels}) | "
                f"processing_time={elapsed_ms:.1f}ms"
            )
        else:
            logger.info(
                f"[{request_id}] ℹ️ No pets detected | "
                f"filename='{filename}' | processing_time={elapsed_ms:.1f}ms"
            )

        return PetDetectionResponse(
            success=success,
            count=len(detections),
            detections=detections,
        )

    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        logger.error(f"[{request_id}] ❌ Pet detection failed: {exc}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Pet detection failed: {exc}",
        ) from exc


# ---------------------------------------------------------------------------
# WebSocket: WS /pet/detect/live
# ---------------------------------------------------------------------------

@router.websocket("/pet/detect/live")
async def pet_detect_live(websocket: WebSocket) -> None:
    """
    WebSocket endpoint for real-time pet detection from a browser webcam.

    Protocol (client → server):
        {"type": "frame", "image": "<base64 data-URL>"}
        {"type": "ping"}
        {"type": "stop"}

    Protocol (server → client):
        {"type": "detection", "success": bool, "count": int, "detections": [...]}
        {"type": "ping"}
        {"type": "error", "message": "..."}
    """
    try:
        await websocket.accept()
        logger.info("Pet detection WebSocket connection established")
    except Exception as exc:
        logger.error(f"Failed to accept WebSocket: {exc}")
        return

    if not YOLOPetDetector.is_available():
        await websocket.send_json({"type": "error", "message": "ultralytics not installed"})
        await websocket.close()
        return

    detector = YOLOPetDetector.instance()
    frame_count = 0
    last_ping = time.time()

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
        except (WebSocketDisconnect, RuntimeError, ConnectionError):
            return False
        except Exception as exc:
            logger.error(f"WebSocket send error: {exc}")
            return False

    try:
        while True:
            now = time.time()
            if now - last_ping > 30:
                if not await safe_send({"type": "ping"}):
                    break
                last_ping = now

            try:
                raw_data = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
            except AsyncTimeoutError:
                if not await safe_send({"type": "ping"}):
                    break
                last_ping = time.time()
                continue
            except (WebSocketDisconnect, ConnectionError, RuntimeError):
                break
            except Exception as exc:
                logger.warning(f"Unexpected WS receive error: {exc}")
                continue

            try:
                message = json.loads(raw_data)

                if message.get("type") == "ping":
                    await safe_send({"type": "pong"})
                    last_ping = time.time()
                    continue

                if message.get("type") == "stop":
                    logger.info("Pet detection WS: client requested stop")
                    break

                image_data = message.get("image")
                if not image_data:
                    continue

                frame_count += 1
                image = _decode_base64_image(image_data)
                raw = detector.detect(image)

                sent = await safe_send(
                    {
                        "type": "detection",
                        "success": len(raw) > 0,
                        "count": len(raw),
                        "detections": raw,
                    }
                )
                if not sent:
                    break

            except ValueError as exc:
                logger.debug(f"Frame decode error: {exc}")
                continue
            except json.JSONDecodeError:
                logger.debug("Invalid JSON in WebSocket message")
                continue
            except Exception as exc:
                logger.error(f"Pet detection frame error: {exc}", exc_info=True)
                if not await safe_send({"type": "error", "message": str(exc)}):
                    break
                continue

    except WebSocketDisconnect:
        logger.info("Pet detection WebSocket client disconnected")
    except Exception as exc:
        logger.error(f"Pet detection WebSocket error: {exc}", exc_info=True)
    finally:
        logger.info(f"Pet detection WebSocket session ended (processed {frame_count} frames)")
