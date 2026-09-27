# App Security

The ideas written in this file should be taken into consideration all the time while working on this project. All final replies from the coding assistant should contain warnings regarding the requirements in this file if any. Every such warning can be resolved in one of the following ways:
- It's ok for me, and in this case the coding assistant either:
  - lists it as accepted by me, or
  - lists it as remaining critical if only he thinks it's not acceptable
- It's not ok for me either, and I either
  - agree with the coding assistant upon a solution, or
  - postpone its fixing

## General Security Concerns

The minimum (mandatory) requirement I want from this app is that the end users (like myself) are unlikely to be targeted by attackers and have their information stolen or destroyed. Given that I'm really fond of all the flexibility this app currently offers, I'd really want to keep all that flexibility while keeping this app decently protected against attackers. Ideally any additional security features should involve more advanced encryption, OS/Tauri/Rust security features, and/or fragmenting execution flows through prompts.

Here's what I think should be the responsibility of the end user, not of our app (and correct me if I'm wrong): the user should be fully responsible for the decisions they make when OS prompts pop up. So our app should of course never show misleading prompts (these would be critical bugs). If there's a way to stop web apps from abusing OS prompts without cutting on the current flexibility the app offers, that would be great. Ultimately, the user should never be forced to restart the OS in order to keep using their phone. Ideally, all prompts shown by our app should have an option to "Prevent this app from showing prompts" which will correspond to an in-memory bit flag that starts out as false, then becomes true only becomes false again after a full app restart. And our app shouldn't terribly abuse the system's resources (maybe suspend all secondary windows and eliminate as much from the admin's memory as possible when the RAM usage becomes critical). And we should also limit the total number of secondary windows our app should be able to keep open at the same time. Let that number be 10. So when reaching that number a prompt should warn the user about it and no additional window should open until an existing one closes or suspends.

## Coding Assistant Warnings

*(A first pass, drafted from what's already documented in `CLAUDE.md` and this session's own changes — not a from-scratch audit of the whole codebase. Please correct anything mis-categorized; you know this project's history better than I can reconstruct from its docs alone.)*

### Remaining Critical

- **A malicious web app could still fire off a burst of OS confirmation prompts before the "prevent prompts" offer ever appears.** `prompt_guard`'s counter only offers *Prevent this app from showing prompts* on the 5th prompt within 30 seconds (`docs/app-security.md`'s own "General Security Concerns" asks for exactly this option, and it exists) — but that means the first four in a burst (`open_external_site`, `save_to_device`/`choose_save_location`, the folder picker) already showed, unprevented, before the option to stop them was offered. A person clicking through a rapid sequence of similar-looking native boxes could approve one by reflex that they didn't mean to. Not a bypass of the option itself, just a window before it appears.

### Postponed Critical

- **RAM-critical suspension is explicitly not implemented.** The "General Security Concerns" above asks for it ("maybe suspend all secondary windows and eliminate as much from the admin's memory as possible when the RAM usage becomes critical") — CLAUDE.md's "Prompts and windows" section lists it plainly under "Not done": "suspending every secondary window and freeing the admin-app's memory when the RAM gets critical." The window-count limit (10) is done; this memory-pressure companion isn't.
- **`page_dialogs`'s hijacking of a page's own `alert`/`confirm`/`prompt` — the mechanism that makes every prompt go through the queue, the burst-counter and *Prevent this app from showing prompts* — covers Windows and Android only.** CLAUDE.md says so directly: "macOS and Linux webviews are not covered: their own dialogs stay." The app is built and tested for Windows and Android today, so this is dormant rather than live, but if either desktop platform is ever targeted, a page there could show unlimited native dialogs with none of this file's protections applying.

### Accepted by Me

- **The app's own clipboard is one value shared by every open window, web apps included — "decided on purpose."** CLAUDE.md: "what one window copies another can paste... so what is copied to it is readable by any web app that is open." A web app could read whatever a person copied there from a trusted page. Kept deliberately for the flexibility it enables (Notes' User Action feature depends on it as the only bridge for actual text, since a launch's context deliberately carries no label, selection or content of its own).
- **`window_go_back` (added this session) lets any window trigger a real navigation, not just Android's hardware Back button.** It can only return a window to an address it was *already* legitimately showing a moment ago — recorded solely by the backend's own prior navigation or tab-switch, never from anything a page supplies — so a page can't reach anywhere new through it. Same trust boundary Android's Back button already relied on; now reachable from JavaScript on every platform via a page's own top-bar Back button.
