# get-claudette

The Mac side of **[Claudette](https://github.com/jgkinnear/claudette)**, a tiny desk display that shows your
Claude Code sessions: which are working, which need you, their helper agents and token use.

```bash
npx get-claudette            # set up: hooks, start at login, opens http://localhost:3333
npx get-claudette start      # or just run it now, until you close the terminal
```

Then:

- **Try it without hardware:** open the [live demo](https://jgkinnear.github.io/claudette/), choose
  **Live from my Mac**, and approve its pairing code at <http://localhost:3333>.
- **Build the display:** see the [project README](https://github.com/jgkinnear/claudette#build-your-own).

Other commands: `npx get-claudette status`, `doctor`, `logs`, `restart` and `uninstall`.

Everything stays on your network. Claudette reads Claude Code's session list, hook events and token counts. It never
reads prompts or code, and it never approves anything for you. Setup backs up `~/.claude/settings.json` and only adds
Claudette's own entries; `claudette uninstall` removes exactly those.

Requires macOS (Linux works for `start`), Node 22+ and Claude Code.

Unofficial; not affiliated with or endorsed by Anthropic. MIT licensed.
