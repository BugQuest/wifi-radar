#!/usr/bin/env bash
# Quick sanity check of captured serial output. Tolerant of CRLF endings.
for f in "$@"; do
    echo "=== $f ==="
    # Strip \r so $ matches at end-of-line consistently.
    tr -d '\r' < "$f" > "$f.clean"
    total=$(grep -ac '^{' "$f.clean" || true)
    complete=$(grep -ac '^{.*}$' "$f.clean" || true)
    drops_line=$(grep -ao '"drops":[0-9]*' "$f.clean" | head -3 | tr '\n' ' ' || true)
    echo "  total lines starting with {: $total"
    echo "  complete lines (start { end }): $complete"
    echo "  heartbeat drops: $drops_line"
    echo "  by event type:"
    grep -aoE '^\{"t":"[a-z]+"' "$f.clean" | sort | uniq -c
    echo "  by sid:"
    grep -ao '"sid":"[a-zA-Z0-9_-]*"' "$f.clean" | sort | uniq -c
    echo "  sample BROKEN line (starts { does not end }):"
    grep -a '^{' "$f.clean" | grep -av '}$' | head -1 | head -c 200
    echo ""
    rm "$f.clean"
done
