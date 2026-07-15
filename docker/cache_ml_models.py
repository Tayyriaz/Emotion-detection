"""Pre-download HSEmotion + animal ViT weights during Docker build."""
from __future__ import annotations


def main() -> None:
    from hsemotion.facial_emotions import HSEmotionRecognizer
    from transformers import pipeline

    print("Downloading HSEmotion model …")
    HSEmotionRecognizer(model_name="enet_b0_8_best_vgaf", device="cpu")
    print("HSEmotion model cached.")

    print("Downloading animal ViT …")
    pipeline(
        "image-classification",
        model="dima806/pets_facial_expression_detection",
        device="cpu",
    )
    print("Animal ViT cached.")


if __name__ == "__main__":
    main()
