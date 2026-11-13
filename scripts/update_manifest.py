#!/usr/bin/env python3
"""Add a release to manifest.json so Jellyfin servers can see and install it.

Usage: update_manifest.py <version> <zip path> <repo "owner/name"> [changelog]
"""
import datetime
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__)
        return 1

    version, zip_path, repo = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3]
    changelog = sys.argv[4] if len(sys.argv) > 4 else "See the GitHub release notes."

    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", version):
        print(f"Version must have four parts, like 1.0.0.0 (got {version!r})")
        return 1

    build = (ROOT / "build.yaml").read_text(encoding="utf-8")
    target_abi = re.search(r'^targetAbi:\s*"([^"]+)"', build, re.MULTILINE).group(1)

    manifest_path = ROOT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    plugin = manifest[0]
    plugin["owner"] = repo.split("/")[0]

    entry = {
        "version": version,
        "changelog": changelog,
        "targetAbi": target_abi,
        "sourceUrl": f"https://github.com/{repo}/releases/download/v{version}/{zip_path.name}",
        "checksum": hashlib.md5(zip_path.read_bytes()).hexdigest(),
        "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # Newest first; replace an existing entry for the same version.
    plugin["versions"] = [entry] + [v for v in plugin["versions"] if v["version"] != version]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"manifest.json: added {version} (targetAbi {target_abi}, md5 {entry['checksum']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
