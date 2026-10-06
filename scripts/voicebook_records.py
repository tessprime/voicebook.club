#!/usr/bin/env python3
"""List or delete an account's Voicebook recordings.

Recordings are club.voicebook.recording records in the account's own ATProto
repository, each referencing an audio blob. Listing is public and needs no
login. Deleting signs in with a password (use an app password for real
Bluesky accounts: Settings > Privacy and security > App passwords), which is
prompted for, or read from the VOICEBOOK_PASSWORD environment variable.

Deleting a record leaves its audio blob unreferenced; the PDS
garbage-collects unreferenced blobs.

Examples:
    scripts/voicebook_records.py alice.bsky.social
    scripts/voicebook_records.py alice.bsky.social --delete 3mx4hukdxgc26
    scripts/voicebook_records.py alice.bsky.social --clear
    scripts/voicebook_records.py alice.test --env development --clear --yes
"""

import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

COLLECTION = "club.voicebook.recording"

# Where handles and DIDs resolve, per environment (see backend/environments/).
ENVIRONMENTS = {
    "production": {"handle_resolver": "https://bsky.social", "plc": "https://plc.directory"},
    "development": {"handle_resolver": "http://localhost:2583", "plc": "http://localhost:2582"},
}


class XrpcError(Exception):
    pass


def request(method, url, *, params=None, body=None, token=None):
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    headers = {"accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        try:
            detail = json.loads(err.read())
            message = f"{detail.get('error')}: {detail.get('message')}"
        except Exception:
            message = err.reason
        raise XrpcError(f"{method} {url.split('?')[0]} failed ({err.code}): {message}") from None
    except urllib.error.URLError as err:
        raise XrpcError(f"{method} {url.split('?')[0]} failed: {err.reason}") from None


def resolve(identifier, env):
    """Returns (did, handle, pds_url) for a handle or DID."""
    identifier = identifier.lstrip("@")
    if identifier.startswith("did:"):
        did = identifier
    else:
        did = request(
            "GET",
            f"{env['handle_resolver']}/xrpc/com.atproto.identity.resolveHandle",
            params={"handle": identifier},
        )["did"]
    if did.startswith("did:plc:"):
        doc = request("GET", f"{env['plc']}/{did}")
    elif did.startswith("did:web:"):
        doc = request("GET", f"https://{did.removeprefix('did:web:')}/.well-known/did.json")
    else:
        raise XrpcError(f"unsupported DID method: {did}")
    handle = next((aka.removeprefix("at://") for aka in doc.get("alsoKnownAs", []) if aka.startswith("at://")), did)
    pds = next(
        (s["serviceEndpoint"] for s in doc.get("service", []) if s.get("id", "").endswith("#atproto_pds")),
        None,
    )
    if not pds:
        raise XrpcError(f"{did} has no PDS in its DID document")
    return did, handle, pds.rstrip("/")


def list_recordings(pds, did):
    records, cursor = [], None
    while True:
        params = {"repo": did, "collection": COLLECTION, "limit": 100}
        if cursor:
            params["cursor"] = cursor
        page = request("GET", f"{pds}/xrpc/com.atproto.repo.listRecords", params=params)
        records.extend(page.get("records", []))
        cursor = page.get("cursor")
        if not cursor or not page.get("records"):
            return records


def rkey_of(uri):
    return uri.rsplit("/", 1)[-1]


def describe(record):
    value = record["value"]
    audio = value.get("audio") or {}
    work = value.get("work", "?")
    if value.get("chapter"):
        work += f" — Chapter {value['chapter']}"
    duration = f"{value['durationMs'] / 1000:.0f}s" if isinstance(value.get("durationMs"), int) else "?"
    size = f"{audio['size'] / 1024:.0f} KiB" if isinstance(audio.get("size"), int) else "?"
    return f"{rkey_of(record['uri'])}  {value.get('createdAt', '?'):<25} {duration:>6} {size:>9}  {work}"


def sign_in(pds, did, handle):
    password = os.environ.get("VOICEBOOK_PASSWORD") or getpass.getpass(f"Password for {handle} (app password for real accounts): ")
    session = request(
        "POST",
        f"{pds}/xrpc/com.atproto.server.createSession",
        body={"identifier": did, "password": password},
    )
    return session["accessJwt"]


def delete_record(pds, did, token, rkey):
    request(
        "POST",
        f"{pds}/xrpc/com.atproto.repo.deleteRecord",
        body={"repo": did, "collection": COLLECTION, "rkey": rkey},
        token=token,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("account", help="handle or DID, e.g. alice.bsky.social")
    parser.add_argument("--env", choices=ENVIRONMENTS, default="production", help="network to use (default: production)")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--delete", metavar="ID", help="delete one recording, by record key or at:// URI")
    action.add_argument("--clear", action="store_true", help="delete all of the account's recordings")
    parser.add_argument("--yes", "-y", action="store_true", help="don't ask for confirmation")
    args = parser.parse_args()

    env = ENVIRONMENTS[args.env]
    try:
        did, handle, pds = resolve(args.account, env)
        records = list_recordings(pds, did)

        if not args.delete and not args.clear:
            print(f"{handle} ({did}) on {pds}: {len(records)} recording(s)")
            for record in sorted(records, key=lambda r: r["value"].get("createdAt", "")):
                print(describe(record))
            return 0

        if args.delete:
            rkey = rkey_of(args.delete)
            targets = [r for r in records if rkey_of(r["uri"]) == rkey]
            if not targets:
                print(f"{handle} has no recording with ID {rkey}", file=sys.stderr)
                return 1
        else:
            targets = records
            if not targets:
                print(f"{handle} has no recordings")
                return 0

        print(f"About to delete {len(targets)} recording(s) from {handle} ({did}):")
        for record in targets:
            print(f"  {describe(record)}")
        sys.stdout.flush()
        if not args.yes and input("Continue? [y/N] ").strip().lower() != "y":
            print("Cancelled.")
            return 1

        token = sign_in(pds, did, handle)
        for record in targets:
            delete_record(pds, did, token, rkey_of(record["uri"]))
            print(f"deleted {rkey_of(record['uri'])}")
        return 0
    except XrpcError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
