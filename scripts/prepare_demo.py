#!/usr/bin/env python3
"""Copy only the checked-in synthetic fixture into this checkout's demo home."""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys

MARKER = ".neuron-vault-demo.json"
IDENTITY = {"format": 1, "dataset": "invented-prism-hall-v1", "synthetic": True}


def reject_symlinks(path: Path) -> None:
    if path.is_symlink():
        raise ValueError(f"不接受符号链接：{path.name}")
    if not path.is_dir():
        raise ValueError(f"目录不存在：{path.name}")
    for current, directories, files in os.walk(path, followlinks=False):
        for name in directories + files:
            if (Path(current) / name).is_symlink():
                raise ValueError("演示目录内不能包含符号链接。")


def prepare(project_root: Path, reuse: bool = False) -> Path:
    """Never merge a fixture into an existing directory, even an empty one."""
    project_root = project_root.resolve(strict=True)
    source = project_root / "demo" / "vault"
    destination = project_root / ".demo-data"
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_dir():
            raise ValueError(".demo-data 已存在且不是普通目录；拒绝操作。")
        if not reuse:
            raise ValueError(".demo-data 已存在；不会覆盖。继续使用已有演示请加 --reuse。")
        reject_symlinks(destination)
        marker = destination / MARKER
        if not marker.is_file():
            raise ValueError("已有目录没有合成演示标记；拒绝将它当作演示库。")
        try:
            identity = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ValueError("演示标记无法读取；拒绝继续。") from error
        if identity != IDENTITY:
            raise ValueError("演示标记不匹配；拒绝继续。")
        if not (destination / "vault").is_dir():
            raise ValueError("已有演示缺少 vault 目录；不会自动修复或覆盖。")
        return destination
    if reuse:
        raise ValueError("尚无 .demo-data；首次启动不需要 --reuse。")
    if (project_root / "demo").is_symlink():
        raise ValueError("demo 种子目录不能是符号链接。")
    reject_symlinks(source)
    if not list(source.rglob("*.md")):
        raise ValueError("合成演示种子不包含 Markdown 笔记。")
    # mkdir is exclusive, including against another simultaneous demo launch.
    # If copying fails, keep this partial directory for manual inspection. Never
    # recursively remove a path that may have acquired user changes meanwhile.
    destination.mkdir(mode=0o700)
    shutil.copytree(source, destination / "vault")
    marker = destination / MARKER
    with marker.open("x", encoding="utf-8") as output:
        json.dump(IDENTITY, output, ensure_ascii=False, indent=2)
        output.write("\n")
    marker.chmod(0o600)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="准备独立合成演示副本，不覆盖已有数据。")
    parser.add_argument("--reuse", action="store_true", help="只验证并复用已有演示，不重新复制种子")
    args = parser.parse_args()
    if os.environ.get("VAULT_HOME"):
        parser.error("已设置 VAULT_HOME。请使用 env -u VAULT_HOME ./scripts/demo.sh，避免混用个人库。")
    try:
        destination = prepare(Path(__file__).resolve().parent.parent, args.reuse)
    except (OSError, ValueError) as error:
        print(f"演示准备失败：{error}", file=sys.stderr)
        return 1
    print(f"合成演示已{'复用' if args.reuse else '创建'}：{destination}")
    print("仅包含虚构演示资料；未复制个人库、配置或密钥。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
