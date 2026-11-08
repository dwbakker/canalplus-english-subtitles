#!/bin/bash
# Installs English Subtitles for CANAL+: builds the Mac app (with the Safari extension inside)
# and puts it in ~/Applications. Safe to re-run: it checks what's missing, says how to fix it,
# and updates an existing install.
#
#   ./install.sh
set -uo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
stop() {
  printf '  \033[31m✗\033[0m %s\n\n' "$1"
  shift
  for line in "$@"; do printf '    %s\n' "$line"; done
  printf '\n  Then run ./install.sh again.\n'
  exit 1
}

bold "Checking what's needed"

major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 26 ] || stop "macOS 26 or later is needed (this Mac has $(sw_vers -productVersion))." \
  "Update macOS in System Settings → General → Software Update."
ok "macOS $(sw_vers -productVersion)"

if [ ! -d /Applications/Xcode.app ]; then
  open "macappstore://apps.apple.com/app/id497799835" 2>/dev/null
  stop "Xcode isn't installed." "Install Xcode from the App Store (free; it just opened), then open it once."
fi
ok "Xcode"

if ! xcodebuild -license check >/dev/null 2>&1; then
  stop "Xcode's license hasn't been accepted yet." "Run:  sudo xcodebuild -license accept   (asks for your password)"
fi
ok "Xcode license accepted"

command -v npm >/dev/null || stop "Node.js isn't installed." \
  "Install it from https://nodejs.org (LTS), or with Homebrew:  brew install node"
ok "Node.js $(node --version)"

team_known() {
  [ -n "${TEAM:-}" ] || [ -s apple/.team ] ||
    grep -q '"DEVELOPMENT_TEAM"' "apple/English Subtitles for CANAL+/English Subtitles for CANAL+.xcodeproj/project.xcproj" ||
    defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | grep -q teamID
}
if ! team_known; then
  if ! defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists >/dev/null 2>&1; then
    open -a Xcode
    stop "Xcode doesn't have your Apple ID yet (needed to sign the app; a free account works)." \
      "In Xcode: Settings… (⌘,) → Accounts → + → Apple Account, and sign in."
  fi
  open -a Xcode "apple/English Subtitles for CANAL+/English Subtitles for CANAL+.xcodeproj"
  stop "Xcode needs to know which team signs the app (once)." \
    "In the project that just opened: click the blue project icon at the top of the sidebar," \
    "select the target \"English Subtitles for CANAL+\" → Signing & Capabilities → Team → your name (Personal Team)."
fi
ok "Apple ID and signing team"

echo
bold "Building"
[ -d node_modules ] || npm ci --silent || stop "npm install failed." "Check your internet connection."
apple/build.sh || stop "The build failed (see above)." "If it's a signing error, re-check the team in Xcode (see the README)."

echo
bold "Installed. Last steps:"
cat <<'EOF'
  1. Quit and reopen Safari.
  2. In the app window that just opened: turn on the extension in Safari, and download
     French and English for Apple's translator.
  3. On canalplus.com, start a show and pick "Anglais" in the subtitle menu.
EOF
