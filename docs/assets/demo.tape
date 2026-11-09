# The terminal half of the demo, for VHS (https://github.com/charmbracelet/vhs): starting the local demo
# relay and connecting Alice's directory. The web half is scripts/record-demo.ts (`npm run demo:record`).
#
#   vhs docs/assets/demo.tape        (writes docs/assets/demo-terminal.gif)
#
# It starts a relay on port 7417 for the length of the recording (stop any other relay on that port first),
# opens Alice's and Bob's sign-in pages in your browser, and registers the klatsch MCP server for
# /tmp/klatsch-alice in your Claude Code config for the length of the recording (the hidden last step disconnects it).

Output docs/assets/demo-terminal.gif

Require npx
Require claude

Set Shell zsh
Set FontSize 16
Set Width 1100
Set Height 640
Set Padding 24
Set TypingSpeed 45ms
Set Theme "Builtin Light"

Hide
Type "export KLATSCH_DIR=$(mktemp -d)" Enter
Type "clear" Enter
Show

# The relay with two people, Alice and Bob; it prints a connect line for each.
Type "npx -y klatsch up --demo --data $KLATSCH_DIR &" Sleep 500ms Enter
Sleep 6s

# Alice connects Claude Code in her project; the token goes to a 0600 file, never to the screen.
Type "mkdir -p /tmp/klatsch-alice && cd /tmp/klatsch-alice" Enter
Sleep 500ms
Type "npx -y klatsch connect --demo --user alice --data $KLATSCH_DIR" Sleep 500ms Enter
Sleep 5s

Hide
Type "npx -y klatsch disconnect --demo --user alice --data $KLATSCH_DIR; kill %1; cd -; rm -rf $KLATSCH_DIR" Enter
Sleep 3s
