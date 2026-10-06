# Installing audio/video codecs

Some video files — an `.mkv` with AC3, DTS or TrueHD audio is the common case — use a codec this app's built-in
player (the same engine every modern browser uses) was never built with a decoder for, usually for licensing
reasons rather than a technical one. The video itself often still plays; it's the *audio track* on that kind of
file that's silent.

## Windows

The Notes app's File Manager and Note Files Explorer have a **Convert for compatible playback** button
(the magic-wand icon, shown at the top of the video viewer) for exactly this case: it decodes the file with
whatever codec **Windows itself** can find a decoder for — including one a codec pack you've installed has
registered — and makes a converted copy that plays normally, cached so asking again for the same file is
instant. It only needs one thing from you: Windows has to actually have a decoder for the file's codec in the
first place. If the button's own error names the problem ("This file's audio can't be decoded…"), Windows
doesn't currently have one.

- **A plain Windows install is "N" or "KN" edition** (common in parts of Europe and Korea) ships with the media
  features removed entirely — install Microsoft's own **Media Feature Pack** for your Windows version first
  (search "Media Feature Pack" on Microsoft's own support site, from your Settings → System → About page's own
  "Edition" line) before anything else here.
- **A third-party codec pack** registers extra decoders — including AC3/DTS ones most Windows installs don't
  have on their own — with Windows Media Foundation, which both this app's own conversion feature and most
  other Windows media software can then use. Several exist; this app doesn't bundle or recommend a specific one,
  since that changes over time and isn't something to vouch for sight unseen. If you install one, prefer options
  you can find independent, recent reviews of, and be careful during its own installer about any bundled browser
  toolbars or other unrelated software it may offer to install alongside the codecs — decline those.
- Once installed, just press **Convert for compatible playback** again on the same file — nothing else in the
  app needs to be told a codec pack now exists.

## Android

Android's own codec support is built into the device's firmware by its manufacturer, not something you install
or extend yourself the way a Windows codec pack works — there's no equivalent "add a codec" step. This app's
own conversion feature isn't available on Android yet either (the same feature on Windows above), so a file
whose audio Android's WebView can't decode will currently stay silent there regardless.

The one thing that reliably works: convert the file **on a Windows machine** first (the button above), then
copy the converted file to your Android device and open that instead — it's an ordinary H.264/AAC MP4 by then,
which every Android device plays.
