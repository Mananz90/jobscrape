#!/bin/bash
# Scripted wizard run (answers piped in) — a quick regression check that the flow still works end to end.
# Usage: tests/wizard-smoke.sh [profile-number]   (defaults: Match a CV → first saved profile → defaults → 30d → LinkedIn+Glassdoor+Muse → 20 results)
cd "$(dirname "$0")/.."
printf '2\n%s\n\n\n\n\n\n\n\n5\n2,5,11\n20\n\nn\ny\n1\nm\n8\n' "${1:-1}" | JOBSCRAPE_BROWSER_DETAILS=3 node --env-file-if-exists=.env src/index.ts 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^Plan|jobs \(|^[0-9]+ +[0-9]+%|^✗|never seen"
