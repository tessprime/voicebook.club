#!/usr/bin/env python3
"""Manage the closed-beta allowlist (and admins) in the environment configs.

The configs hold DIDs, since handles can change; this script takes handles
and resolves them, checking both directions (the handle resolves to the DID,
and the DID's document claims the handle), so the right account is invited.

    scripts/invite.py add alice.bsky.social            # invite
    scripts/invite.py add alice.bsky.social --admin    # invite as admin
    scripts/invite.py remove alice.bsky.social         # also accepts a DID
    scripts/invite.py list                             # current handles, looked up live

By default it edits the container environments, app-platform.json and
droplet.json, which share one invite list; --env picks others (repeatable).
Changes take effect when the backend restarts: on App Platform, the config is
built into the image, so rebuild, push and deploy.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from voicebook_records import ENVIRONMENTS, XrpcError, resolve  # noqa: E402

CONFIG_DIR = Path(__file__).parent.parent / "backend" / "environments"
DEFAULT_ENVS = ["app-platform", "droplet"]


def network_for(env_name):
    """Where handles resolve for an environment: the local network or Bluesky."""
    return ENVIRONMENTS["development"] if env_name == "development" else ENVIRONMENTS["production"]


def load(env_name):
    path = CONFIG_DIR / f"{env_name}.json"
    if not path.exists():
        raise SystemExit(f"no such environment: {path}")
    return path, json.loads(path.read_text())


def save(path, config):
    path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n")


def resolve_account(identifier, env_name):
    """Returns (did, handle), verified in both directions for handles."""
    identifier = identifier.strip().lstrip("@")
    did, handle, _pds = resolve(identifier, network_for(env_name))
    if not identifier.startswith("did:") and handle.lower() != identifier.lower():
        raise SystemExit(
            f"{identifier} resolves to {did}, but that DID's document claims the handle {handle!r}, "
            "not this one: refusing (the handle may be misconfigured or spoofed)"
        )
    return did, handle


def add(args):
    did, handle = resolve_account(args.account, args.envs[0])
    print(f"{handle} → {did}")
    for env_name in args.envs:
        path, config = load(env_name)
        access = config.setdefault("access", {})
        if "allowlist" not in access:
            print(f"  {env_name}: open (no allowlist); not changing it")
            continue
        changed = []
        if did not in access["allowlist"]:
            access["allowlist"].append(did)
            changed.append("allowlist")
        if args.admin and did not in access.setdefault("admins", []):
            access["admins"].append(did)
            changed.append("admins")
        if changed:
            save(path, config)
            print(f"  {env_name}: added to {' and '.join(changed)}")
        else:
            print(f"  {env_name}: already {'an admin' if args.admin else 'invited'}")


def remove(args):
    target = args.account.strip().lstrip("@")
    did = target if target.startswith("did:") else resolve_account(target, args.envs[0])[0]
    for env_name in args.envs:
        path, config = load(env_name)
        access = config.get("access", {})
        changed = [key for key in ("allowlist", "admins") if did in access.get(key, [])]
        for key in changed:
            access[key].remove(did)
        if changed:
            save(path, config)
            print(f"{env_name}: removed {did} from {' and '.join(changed)}")
        else:
            print(f"{env_name}: {did} wasn't listed")


def list_invites(args):
    for env_name in args.envs:
        _path, config = load(env_name)
        access = config.get("access", {})
        allowlist, admins = access.get("allowlist"), set(access.get("admins", []))
        if allowlist is None:
            print(f"{env_name}: open (no allowlist); admins: {len(admins)}")
            continue
        print(f"{env_name}: {len(allowlist)} invited")
        for did in sorted(set(allowlist) | admins):
            try:
                _, handle, _ = resolve(did, network_for(env_name))
            except XrpcError as err:
                handle = f"(unresolvable: {err})"
            role = "admin" if did in admins else ""
            print(f"  {did}  {handle:<30} {role}".rstrip())


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--env", dest="envs", action="append", metavar="NAME",
                        help=f"environment to edit (repeatable; default: {', '.join(DEFAULT_ENVS)})")
    commands = parser.add_subparsers(dest="command", required=True)
    add_parser = commands.add_parser("add", help="invite an account")
    add_parser.add_argument("account", help="handle (or DID)")
    add_parser.add_argument("--admin", action="store_true", help="also make it an admin")
    remove_parser = commands.add_parser("remove", help="withdraw an invite (and admin rights)")
    remove_parser.add_argument("account", help="handle or DID")
    commands.add_parser("list", help="show invited accounts")
    args = parser.parse_args()
    args.envs = args.envs or DEFAULT_ENVS
    try:
        {"add": add, "remove": remove, "list": list_invites}[args.command](args)
    except XrpcError as err:
        raise SystemExit(f"error: {err}")


if __name__ == "__main__":
    main()
