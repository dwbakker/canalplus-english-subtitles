#!/bin/bash
# Builds the Mac app (with the Safari extension inside), installs it in ~/Applications and opens it.
# Needs Xcode with your Apple ID added (Xcode > Settings > Accounts; a free account works).
# Usage: apple/build.sh            (team detected from Xcode)
#        TEAM=ABCDE12345 apple/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

PROJECT="apple/English Subtitles for CANAL+/English Subtitles for CANAL+.xcodeproj"
TEAM_FILE="apple/.team" # remembered locally, not committed
# Team: $TEAM, else the remembered one, else picked in Xcode (Signing & Capabilities), else Xcode's team list.
[ -z "${TEAM:-}" ] && [ -f "$TEAM_FILE" ] && TEAM=$(cat "$TEAM_FILE")
[ -z "${TEAM:-}" ] && TEAM=$(sed -n 's/.*"DEVELOPMENT_TEAM": "\([A-Z0-9]*\)".*/\1/p' "$PROJECT/project.xcproj" | head -1)
[ -z "${TEAM:-}" ] && TEAM=$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | sed -n 's/.*teamID = \([A-Z0-9]*\);.*/\1/p' | head -1 || true)
if [ -z "$TEAM" ]; then
  echo "No Apple development team found. Add your Apple ID in Xcode > Settings > Accounts, then open the project in Xcode," >&2
  echo "select the app target > Signing & Capabilities and pick your team (or run TEAM=<team id> $0)." >&2
  exit 1
fi

echo "$TEAM" > "$TEAM_FILE"

npm run build
DERIVED="${TMPDIR:-/tmp}/canalplus-subtitles-build"
xcodebuild -project "$PROJECT" -scheme "English Subtitles for CANAL+" -configuration Release \
  -derivedDataPath "$DERIVED" -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" build -quiet

APP="English Subtitles for CANAL+.app"
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/$APP"
cp -R "$DERIVED/Build/Products/Release/$APP" "$HOME/Applications/"
echo "Installed ~/Applications/$APP"
open "$HOME/Applications/$APP"
