#!/bin/bash
# Double-click on a Mac to refresh the dashboard data.
cd "$(dirname "$0")" || exit 1

fail() { echo; echo "Something went wrong - scroll up for the error, or screenshot this window."; read -r -p "Press Enter to close"; exit 1; }

echo; echo "[1/4] Syncing with GitHub..."
git pull --rebase --autostash || fail

echo; echo "[2/4] Checking Python packages..."
python3 -m pip install -q --disable-pip-version-check --user -r requirements.txt || fail

echo; echo "[3/4] Pulling stats from NBA.com (takes a few minutes)..."
python3 scripts/fetch_data.py || fail

echo; echo "[4/4] Uploading to GitHub..."
git add docs/data
git commit -q -m "Update NBA data"
git push || fail

echo; echo "Done! The site updates in 1-2 minutes:"
echo "https://elin1705.github.io/nbadash/"
read -r -p "Press Enter to close"
