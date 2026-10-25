#!/usr/bin/env python3
"""Stage public build inputs with modes readable by the image's non-root user."""

import shutil
import sys
from pathlib import Path


def stage_context(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        raise ValueError("The crowd-estimation source must be an ordinary directory.")
    if destination.is_symlink() or not destination.is_dir() or any(destination.iterdir()):
        raise ValueError("The build destination must be an empty ordinary directory.")
    # The host context stays private even though its public source files must be
    # readable by UID 10001 after Docker COPY preserves their permission bits.
    destination.chmod(0o700)

    def copy_file(original: Path, target: Path) -> None:
        target.parent.mkdir(parents=True, exist_ok=True)
        for directory in target.relative_to(destination).parents:
            if directory != Path("."):
                (destination / directory).chmod(0o755)
        shutil.copyfile(original, target)
        target.chmod(0o644)

    for name in ("Dockerfile", "pyproject.toml", "uv.lock", "THIRD_PARTY_NOTICES.md"):
        original = source / name
        if original.is_symlink() or not original.is_file():
            raise ValueError("A required crowd-estimation build source is missing or is a symlink.")
        copy_file(original, destination / name)

    app = source / "app"
    if app.is_symlink() or not app.is_dir():
        raise ValueError("The crowd-estimation app source must be an ordinary directory.")
    for original in app.rglob("*"):
        relative = original.relative_to(app)
        if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
            continue
        if original.is_symlink():
            raise ValueError("The crowd-estimation build context cannot contain symlinks.")
        if original.is_dir() or original.suffix != ".py":
            continue
        copy_file(original, destination / "app" / relative)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: stage-crowd-estimation.py SOURCE EMPTY_DESTINATION")
    try:
        stage_context(Path(sys.argv[1]), Path(sys.argv[2]))
    except ValueError as error:
        raise SystemExit(str(error)) from error
