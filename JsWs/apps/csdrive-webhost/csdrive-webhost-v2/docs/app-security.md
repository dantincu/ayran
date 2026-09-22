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

### Remaining Critical

### Postponed Critical

### Accepted by Me
