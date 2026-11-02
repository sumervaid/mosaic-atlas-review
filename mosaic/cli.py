"""Command line entry point: serve the API, import recorded runs, and manage a Google Cloud machine."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mosaic")
    sub = ap.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="Start the API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    imp = sub.add_parser("import-pilot", help="Import recorded pilot runs")
    imp.add_argument("pilot", type=Path)
    imp.add_argument("--out", type=Path, default=Path("data/imported"))
    g = sub.add_parser("gcp", help="Manage a GPU machine on Google Cloud")
    g.add_argument("action", choices=["configure", "up", "tunnel", "status", "down"])
    g.add_argument("--key", help="Path to a service account key file")
    g.add_argument("--project")
    g.add_argument("--zone")
    g.add_argument("--profile", choices=["4b", "12b"])
    g.add_argument("--hf-token-file", help="Path to a file holding a Hugging Face token")
    g.add_argument("--instance")
    g.add_argument("--execute", action="store_true", help="Run the commands. Without this flag they are only printed.")
    args = ap.parse_args(argv)
    if args.cmd == "serve":
        import uvicorn

        uvicorn.run("mosaic.api.app:app", host=args.host, port=args.port)
        return 0
    if args.cmd == "import-pilot":
        from mosaic.importers.pilot import run_import

        run_import(args.pilot, args.out)
        return 0
    from mosaic.compute import gcp

    s = gcp.load_settings()
    for field, value in (("key_path", args.key), ("project", args.project), ("zone", args.zone), ("profile", args.profile),
                         ("hf_token_path", args.hf_token_file), ("instance", args.instance)):
        if value:
            setattr(s, field, value)
    if args.action == "configure":
        info = gcp.check_key(s.key_path)
        s.project = s.project or info["project_id"]
        gcp.save_settings(s)
        print(json.dumps({"key": info, "project": s.project, "zone": s.zone, "profile": s.profile, "problems": gcp.validate(s)}, indent=1))
        return 0
    if args.action == "tunnel":
        print(" ".join(gcp.tunnel_command(s)))
        return 0
    if args.action == "status":
        print(gcp.instance_status(s) or "No machine found.")
        return 0
    problems = gcp.validate(s, need_hf=args.action == "up")
    if problems:
        print("\n".join(problems))
        return 2
    commands = gcp.up_commands(s) if args.action == "up" else gcp.down_commands(s)
    result = gcp.run(commands, s, dry_run=not args.execute, on_line=print)
    if result["dry_run"]:
        print("These commands would run. Add --execute to run them. A running machine bills by the hour.\n")
        print("\n".join(result["commands"]))
        return 0
    if not result["ok"]:
        print(result["steps"][-1]["stderr"])
        return 1
    print("Done.")
    if args.action == "up":
        print("Open the tunnel with:\n" + " ".join(gcp.tunnel_command(s)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
