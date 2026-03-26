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

sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.json

pnpm run build

7z a -tzip "pagetomd-${VERSION}.zip" \
	manifest.json \
	dist \
	icons \
	-xr!*.md* -xr!*.sh* -xr!.gitignore
echo "Build complete: pagetomd-${VERSION}.zip"
