"""Explicit setup/build step; never invoked by the request handler."""

import argparse
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="zip-n-nwpu.pth")
    parser.add_argument("--output", type=Path, default=Path("models"))
    args = parser.parse_args()
    if args.model == "zip-n-nwpu.pth":
        from app.density_weights import prepare_weights
        prepare_weights(args.output / args.model)
        print(f"Prepared {args.model} (pinned author checkpoint)")
        return
    if Path(args.model).name != args.model or not args.model.endswith(".pt"):
        parser.error("Choose an official .pt weight filename, without a directory or URL.")
    args.output.mkdir(parents=True, exist_ok=True)
    os.chdir(args.output.resolve())
    from ultralytics import YOLO
    model = YOLO(args.model)
    if model.task != "detect" or model.names[0] != "person":
        raise RuntimeError("Expected detection weights with COCO class 0 named person.")
    if not Path(args.model).is_file():
        raise RuntimeError("Weight download did not produce the requested file.")
    print(f"Prepared {args.model}")


if __name__ == "__main__":
    main()
