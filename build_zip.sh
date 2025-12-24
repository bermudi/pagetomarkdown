VERSION=$(grep -o '"version": "[^"]*"' manifest.json | cut -d'"' -f4)
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

7z a -tzip "pagetomd-${VERSION}.zip" \
  manifest.json \
  dist \
  icons \
  -xr!*.md* -xr!*.sh* -xr!.gitignore
echo "Build complete: pagetomd-${VERSION}.zip"