#!/usr/bin/env python3

import json
import pathlib
import sys


PLUGIN_SPEC = "./plugins/background-agents-tui"
SCHEMA = "https://opencode.ai/tui.json"


def item_spec(item):
    if isinstance(item, str):
        return item
    if isinstance(item, list) and item and isinstance(item[0], str):
        return item[0]
    return None


def load_data(tui_path: pathlib.Path):
    if not tui_path.exists():
        return {}
    loaded = json.loads(tui_path.read_text())
    if not isinstance(loaded, dict):
        raise ValueError("root must be an object")
    return loaded


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"ensure", "remove"}:
        print("usage: ensure_tui_plugin.py <ensure|remove> <target-dir>", file=sys.stderr)
        return 2

    mode = sys.argv[1]
    target_dir = pathlib.Path(sys.argv[2]).expanduser()
    tui_path = target_dir / "tui.json"

    try:
        data = load_data(tui_path)
    except Exception as exc:  # noqa: BLE001
        print(f"invalid tui.json at {tui_path}: {exc}", file=sys.stderr)
        return 1

    plugin = data.get("plugin")
    if plugin is None:
        plugin_list = []
    elif isinstance(plugin, list):
        plugin_list = plugin
    else:
        print(f"invalid tui.json at {tui_path}: plugin must be an array", file=sys.stderr)
        return 1

    plugin_list = [item for item in plugin_list if item_spec(item) != PLUGIN_SPEC]
    if mode == "ensure":
        plugin_list.append(PLUGIN_SPEC)

    if plugin_list:
        data["plugin"] = plugin_list
        data.setdefault("$schema", SCHEMA)
        tui_path.parent.mkdir(parents=True, exist_ok=True)
        tui_path.write_text(json.dumps(data, indent=2) + "\n")
        return 0

    if tui_path.exists():
        data.pop("plugin", None)
        if len(data) == 0:
            tui_path.unlink()
        else:
            tui_path.write_text(json.dumps(data, indent=2) + "\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
