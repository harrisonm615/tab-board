#!/opt/homebrew/bin/python3 -I
"""Packs this folder into progress-sidebar.vsix, with no build tools needed. Then install it into VS Code:
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension progress-sidebar.vsix --force
Bump "version" in package.json for each new install."""
import json
import subprocess
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
meta = json.loads((HERE / "package.json").read_text())
FILES = ["package.json", "extension.js", "core.js", "prune.js", "ship.js", "gauges.js", "collect.py", "eta.py", "triage.py", "usage.py", "README.md", "media/view.js", "media/view.css", "media/icon.svg"]
MANIFEST = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{meta['name']}" Version="{meta['version']}" Publisher="{meta['publisher']}"/>
    <DisplayName>Tabs &amp; Progress</DisplayName>
    <Description xml:space="preserve">{meta['description']}</Description>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
"""
TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".css" ContentType="text/css"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""
out = HERE / f"{meta['name']}.vsix"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", TYPES)
    z.writestr("extension.vsixmanifest", MANIFEST)
    for name in FILES:
        z.write(HERE / name, f"extension/{name}")
print(out, meta["version"])


# A snapshot at every build, so whatever a later edit loses can be got back. Only where it's been switched on
# (git config progress.autocommit true): a copy inside someone else's repo never commits by itself. It never pushes.
def snapshot(version):
    git = ["git", "-C", str(HERE.parent)]
    ask = dict(capture_output=True, text=True, timeout=30)
    try:
        if subprocess.run([*git, "config", "--local", "--get", "progress.autocommit"], **ask).stdout.strip() != "true":
            return
        subprocess.run([*git, "add", "-A"], check=True, **ask)
        if subprocess.run([*git, "diff", "--cached", "--quiet"], **ask).returncode == 0:
            return
        message = f"Built {version}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
        subprocess.run([*git, "commit", "-q", "-m", message], check=True, **ask)
        print("Snapshot saved in git:", version)
    except (OSError, subprocess.SubprocessError) as error:
        print("Built, but no git snapshot this time:", error)


snapshot(meta["version"])
