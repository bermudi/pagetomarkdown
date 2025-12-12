VERSION=$(grep -o '"version": "[^"]*"' manifest.json | cut -d'"' -f4)
rm -f pagetomd-*.zip
pnpm run build

7z a -tzip "pagetomd-${VERSION}.zip" \
  manifest.json \
  dist \
  icons \
  -xr!*.md* -xr!*.sh* -xr!.gitignore
echo "Build complete: pagetomd-${VERSION}.zip"