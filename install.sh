#!/bin/sh
# Installs Tabs & Progress: the VS Code side bar, and the tab-board plugin each Claude chat uses to report to it.
# Run it again any time to bring both up to date. It needs no password and changes nothing outside VS Code and Claude Code.
# Everything runs from the last line, so a download cut short runs nothing.

BASE=https://raw.githubusercontent.com/harrisonm615/tab-board/main
VSCODE_CLI="Visual Studio Code.app/Contents/Resources/app/bin/code"

stop() {
  printf '\n%s\n' "$1" >&2
  exit 1
}

find_code() {
  for app in "/Applications/$VSCODE_CLI" "$HOME/Applications/$VSCODE_CLI"; do
    if [ -x "$app" ]; then
      printf '%s\n' "$app"
      return
    fi
  done
  command -v code || true
}

# The VS Code extension's own copy first, since most people have no claude command.
find_claude() {
  newest=$(ls -t "$HOME"/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude 2>/dev/null | head -n 1)
  if [ -n "$newest" ]; then
    printf '%s\n' "$newest"
    return
  fi
  command -v claude || true
}

has_python() {
  [ -x /opt/homebrew/bin/python3 ] || [ -x /usr/local/bin/python3 ] || xcode-select -p >/dev/null 2>&1
}

install_plugin() {
  if "$claude" plugin list </dev/null 2>/dev/null | grep -q 'tab-board'; then
    "$claude" plugin marketplace update tab-board </dev/null >/dev/null 2>&1
    "$claude" plugin update tab-board@tab-board </dev/null
  else
    "$claude" plugin marketplace add harrisonm615/tab-board </dev/null >/dev/null 2>&1
    "$claude" plugin install tab-board@tab-board </dev/null
  fi
}

install_side_bar() {
  folder=$(mktemp -d) || return 1
  curl -fsSL -o "$folder/progress-sidebar.vsix" "$BASE/sidebar/progress-sidebar.vsix" &&
    "$code" --install-extension "$folder/progress-sidebar.vsix" --force </dev/null >/dev/null
  result=$?
  rm -rf "$folder"
  return $result
}

main() {
  [ "$(uname -s)" = Darwin ] || stop "Tabs & Progress only works on a Mac. Nothing was installed."

  code=$(find_code)
  [ -n "$code" ] || stop "VS Code isn't installed in Applications. Install it, then run this again. Nothing was installed."

  claude=$(find_claude)
  [ -n "$claude" ] || stop "Claude Code isn't installed. Add the Claude Code extension in VS Code, then run this again. Nothing was installed."

  cd "$HOME" || stop "Couldn't open your home folder. Nothing was installed."

  echo "Installing the tab-board plugin..."
  install_plugin || stop "The plugin didn't install, so the side bar wasn't installed either. Run this again, or send this message to whoever shared it."

  echo "Installing the side bar..."
  install_side_bar || stop "The plugin installed, but the side bar didn't. Run this again, or send this message to whoever shared it."

  if ! has_python; then
    echo
    echo "One more thing: the side bar needs Python, which comes with Apple's developer tools."
    echo "A box from macOS should open now. Press Install. It's free and takes a few minutes."
    xcode-select --install >/dev/null 2>&1
  fi

  echo
  echo "Done. In VS Code, press Cmd+Shift+P and run Developer: Reload Window."
  echo "A reload stops whatever your chats are running, so wait for a quiet moment."
  echo "Tabs & Progress then shows up as an icon on the left edge of the window."
}

main "$@"
