#!/usr/bin/env bash
set -euo pipefail
VERSION=$(grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4)
rm -f pagetomd-*.zip

if [ ! -d "node_modules" ]; then
	read -p "node_modules not found. Install dependencies? [y/N] " -n 1 -r
	echo
	if [[ $REPLY =~ ^[Yy]$ ]]; then
		pnpm install
	else
		echo "Aborting build."
		exit 1
	fi
fi

pnpm run build

# Stage packaging without mutating the tracked manifest.json
# package.json is the single source of truth; we patch a copy in a temp dir.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp manifest.json "$STAGE/manifest.json"
if command -v jq >/dev/null 2>&1; then
	jq --arg v "$VERSION" '.version = $v' "$STAGE/manifest.json" > "$STAGE/manifest.json.tmp" && mv "$STAGE/manifest.json.tmp" "$STAGE/manifest.json"
else
	sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$STAGE/manifest.json"
fi

# Copy built assets and icons into stage
mkdir -p "$STAGE/dist"
cp -r dist/* "$STAGE/dist/" 2>/dev/null || true
cp -r icons "$STAGE/"

# Create zip from stage so tracked manifest.json is never dirtied
(
	cd "$STAGE"
	7z a -tzip "$OLDPWD/pagetomd-${VERSION}.zip" manifest.json dist icons -xr!*.md* -xr!*.sh* -xr!.gitignore -xr!*.xcf -xr!*.map >/dev/null
)
echo "Build complete: pagetomd-${VERSION}.zip"

# Verification: ensure we didn't dirty the tracked manifest
if ! git diff --quiet manifest.json 2>/dev/null; then
	echo "Warning: manifest.json is dirty after build (should not happen with staged build)" >&2
	git diff manifest.json >&2 || true
fi
