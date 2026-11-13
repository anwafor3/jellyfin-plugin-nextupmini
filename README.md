# Next Up Mini for Jellyfin

When an episode's end credits start, the Jellyfin **web player** shrinks the credits into a
corner and shows what's up next: the next episode's title and artwork, a countdown ring, and
**Play now** / **Watch credits** buttons. When the countdown ends, the next episode starts.

- **Enter** plays the next episode now. **Esc** keeps watching the credits at full size.
- Pausing pauses the countdown. Seeking back before the credits closes the overlay.
- Jellyfin's own small "Next Episode" card is hidden while the overlay shows (optional).

## Where it works

Next Up Mini runs inside Jellyfin's web player, so it works anywhere that player is used:

| Client | Works? |
|---|---|
| Web browser | Yes |
| Jellyfin Media Player (desktop) | Yes |
| LG webOS / Samsung Tizen apps | Expected (they load the server's web player), not yet tested |
| Swiftfin, Android TV, Roku, Infuse and other apps with their own player | No |

## Requirements

- **Jellyfin 12.0 or newer.**
- **Credits markers** (recommended): install [Intro Skipper](https://github.com/intro-skipper/intro-skipper)
  or another plugin that creates *Outro* media segments. Without markers, Next Up Mini uses
  chapters named like "Credits", then falls back to a fixed time before the end (30 s by default).
- **[File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)**
  (recommended): lets Next Up Mini add its script to the web player in memory. This works in
  Docker and survives Jellyfin updates. Without it, Next Up Mini edits the web player's
  `index.html` on disk at every server start, which needs write access to Jellyfin's web folder.

## Install

1. In Jellyfin, go to **Dashboard → Plugins → Repositories** and add:
   - **Name:** `Next Up Mini`
   - **URL:** `https://raw.githubusercontent.com/anwafor3/jellyfin-plugin-nextupmini/main/manifest.json`
2. Open **Catalog**, install **Next Up Mini**, and restart Jellyfin.
3. Hard-refresh the web player in your browser (Ctrl+Shift+R / ⌘⇧R).

## Settings

**Dashboard → Plugins → Next Up Mini**

| Setting | Default | |
|---|---|---|
| Enable | On | |
| Countdown | 10 s | 3–60 seconds |
| Fallback | 30 s | Seconds before the end when there's no credits marker; 0 turns it off |
| Use chapters named "Credits" | On | Checked after media segments |
| Mini player width | 28 % | 15–45 % of the screen width |
| Corner | Bottom right | Or bottom left |
| Hide Jellyfin's "Next Episode" card | On | |

Changes apply the next time the web player loads.

## How it works

- The plugin serves the script at `/NextUpMini/script.js`, with your settings built in.
- At startup it registers with File Transformation to add a `<script>` tag to `index.html`,
  or edits `index.html` directly if File Transformation isn't installed. Uninstalling the
  plugin removes the on-disk tag.
- In the browser, the script reads the current episode from your session, finds the credits
  start (latest *Outro* segment → latest "Credits" chapter → fallback), looks up the next
  episode, and shows the overlay when playback reaches the credits. To start the next episode
  it presses Jellyfin's own **Start Now** button, then the player's next-track button, then
  falls back to the sessions API.

## Build

Requires the .NET 10 SDK.

```sh
dotnet build Jellyfin.Plugin.NextUpMini/Jellyfin.Plugin.NextUpMini.csproj -c Release
```

To install by hand, copy `Jellyfin.Plugin.NextUpMini.dll` into a folder such as
`plugins/NextUpMini_1.0.0.0/` in Jellyfin's data directory and restart Jellyfin.

## Release

1. Update `version` and `changelog` in `build.yaml`.
2. Push a four-part tag, for example `git tag v1.0.0.0 && git push origin v1.0.0.0`.
3. The **Release** workflow builds the zip, publishes a GitHub release, and adds the version to
   `manifest.json` on `main`. Servers see the update the next time they refresh the catalog.

## License

GPL-3.0. See [LICENSE](LICENSE).
