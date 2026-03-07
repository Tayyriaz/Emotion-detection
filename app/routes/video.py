"""
Video Emotion Detection API Routes

WebSocket endpoint for real-time emotion detection from webcam video stream.
Processes frames continuously and sends emotion updates back to client.
"""

import base64
import json
import time

import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.services.models.hsemotion_detector import HSEmotionDetector
from app.utils.logging import get_logger

logger = get_logger(__name__)
settings = get_settings()

router = APIRouter(tags=["Video Emotion"])


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
async def video_emotion_websocket(websocket: WebSocket):
    """
    WebSocket endpoint for real-time emotion detection from video stream.
    
    Client sends base64-encoded image frames, server responds with emotion analysis.
    Optimized for low latency: processes frames efficiently, skips frames if queue is full.
    """
    await websocket.accept()
    logger.info("WebSocket connection established for video emotion detection")
    
    detector = None
    frame_count = 0
    last_emotion = None
    last_confidence = 0.0
    
    try:
        # Initialize detector (singleton, loaded once)
        if not HSEmotionDetector.is_available():
            await websocket.send_json({
                "error": "HSEmotion library not available",
                "type": "error"
            })
            return
        
        detector = HSEmotionDetector.instance()
        
        # Process frames continuously
        while True:
            # Receive frame from client
            data = await websocket.receive_text()
            
            try:
                message = json.loads(data)
                
                # Handle control messages
                if message.get("type") == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                
                if message.get("type") == "stop":
                    logger.info("Client requested stop")
                    break
                
                # Extract image data
                image_data = message.get("image")
                if not image_data:
                    continue
                
                # Decode and process frame
                frame_count += 1
                
                # Skip frames for performance (configurable)
                if frame_count % settings.VIDEO_FRAME_SKIP != 0:
                    continue
                
                start_time = time.time()
                image = _decode_base64_image(image_data)
                
                # Analyze emotion
                result = detector.analyze_image(image)
                
                face_detected = result.get("face_detected", False)
                emotions = result.get("emotions", {}) or {}
                
                if face_detected and emotions:
                    # Get dominant emotion
                    emotion = result.get("emotion", "neutral")
                    confidence = result.get("confidence", 0.0)
                    
                    # Only send update if emotion changed significantly
                    confidence_delta = abs(confidence - last_confidence)
                    if emotion != last_emotion or confidence_delta > settings.VIDEO_MIN_CONFIDENCE_DELTA:
                        last_emotion = emotion
                        last_confidence = confidence
                        
                        inference_time = (time.time() - start_time) * 1000
                        
                        # Send emotion update with bounding box
                        face_bbox = result.get("face_bbox")
                        # Convert NumPy int32 to Python int for JSON serialization
                        if face_bbox and isinstance(face_bbox, tuple):
                            face_bbox = [int(coord) for coord in face_bbox]
                        
                        await websocket.send_json({
                            "type": "emotion",
                            "success": True,
                            "emotion": emotion,
                            "confidence": round(confidence, 3),
                            "emotions": {k: round(v, 3) for k, v in emotions.items()},
                            "face_detected": True,
                            "face_bbox": face_bbox,  # [x1, y1, x2, y2] format (list of ints)
                            "inference_time_ms": round(inference_time, 1),
                        })
                else:
                    # No face detected
                    if last_emotion is not None:
                        await websocket.send_json({
                            "type": "emotion",
                            "success": False,
                            "emotion": "neutral",
                            "confidence": 0.0,
                            "face_detected": False,
                        })
                        last_emotion = None
                
            except ValueError as e:
                logger.debug(f"Frame decode error: {e}")
                continue
            except json.JSONDecodeError:
                logger.debug("Invalid JSON received")
                continue
            except Exception as e:
                logger.error(f"Frame processing error: {e}", exc_info=True)
                await websocket.send_json({
                    "type": "error",
                    "message": str(e)
                })
                continue
                
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
    finally:
        logger.info(f"Video emotion session ended (processed {frame_count} frames)")
