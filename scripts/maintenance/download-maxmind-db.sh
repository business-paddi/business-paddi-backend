#!/usr/bin/env bash
set -euo pipefail

# Git Bash launched from PowerShell may omit its Unix utility directories.
export PATH="/usr/bin:/bin:$PATH"

if [[ -z "${MAXMIND_ACCOUNT_ID:-}" || -z "${MAXMIND_LICENSE_KEY:-}" ]]; then
  echo "MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY are required" >&2
  exit 1
fi

db_path="${MAXMIND_DB_PATH:-data/GeoLite2-City.mmdb}"
db_dir="$(dirname "$db_path")"
work_dir="$(mktemp -d)"
archive_path="$work_dir/GeoLite2-City.tar.gz"
extract_dir="$work_dir/extracted"

cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

mkdir -p -- "$db_dir" "$extract_dir"

curl --fail --show-error --silent --location \
  --user "$MAXMIND_ACCOUNT_ID:$MAXMIND_LICENSE_KEY" \
  "https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz" \
  --output "$archive_path"

tar -xzf "$archive_path" -C "$extract_dir"

mmdb_file="$(find "$extract_dir" -type f -name 'GeoLite2-City.mmdb' -print -quit)"

if [[ -z "$mmdb_file" ]]; then
  echo "GeoLite2-City.mmdb was not found in the downloaded archive" >&2
  exit 1
fi

temporary_db="$db_path.tmp"
cp -- "$mmdb_file" "$temporary_db"
mv -f -- "$temporary_db" "$db_path"

echo "Downloaded MaxMind database to $db_path"
