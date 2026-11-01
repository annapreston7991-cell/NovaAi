#!/bin/bash
# Copyright (c) 2026 LLYVerse — https://llyverse.org
# Licensed under the LLYVerse License 1.0. See LICENSE. Credit to LLYVerse is required.
# Nova AI Standalone Android App Installer (Termux & Mobile CLI)
set -e

echo "===================================================="
echo "🤖 NOVA AI STANDALONE ANDROID APP INSTALLER"
echo "===================================================="
echo ""

APP_DIR="$HOME/.nova-ai"
mkdir -p "$APP_DIR"

echo "-> Creating Nova Launcher executable..."
cat << 'EOF' > "$APP_DIR/nova"
#!/bin/bash
echo "Launching Nova AI Standalone App..."
if command -v termux-open >/dev/null 2>&1; then
 termux-open https://llyverse.org/nova
elif command -v xdg-open >/dev/null 2>&1; then
 xdg-open https://llyverse.org/nova
else
 echo "Open https://llyverse.org/nova in your browser."
fi
EOF

chmod +x "$APP_DIR/nova"

# Add to PATH if in Termux
if [ -d "$HOME/../usr/bin" ]; then
 cp "$APP_DIR/nova" "$HOME/../usr/bin/nova"
 echo "✅ Nova CLI launcher installed! Type 'nova' anywhere in Termux to launch."
elif [ -d "$HOME/bin" ]; then
 cp "$APP_DIR/nova" "$HOME/bin/nova"
 echo "✅ Nova launcher installed to $HOME/bin/nova!"
fi

echo ""
echo "===================================================="
echo "🎉 NOVA AI INSTALLATION COMPLETE!"
echo " Run 'nova' to launch Nova AI Standalone App."
echo "===================================================="
