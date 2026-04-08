# Ayran Baby Sitter App

I want to create an app that helps parents hear their baby's cries when they are away from their little one.
To use this app the user will need at least 2 phones and the app will have 2 modes of operation:

- The host mode: this device sits near (or in the same room with) the baby and records the sounds and/or video of the room
- The client mode: this device(s) will be away from the baby and will be able to discover the host device and listen to what the host device is recording (sound and/or video)

For this the user will have to authenticate with a google account both on the host and on the client device. This is the first step
that runs when the user first opens the app. After this step, there will be a home screen asking the user to choose between the 2 modes.
If the host mode is chosen, then a page shows up where the user can turn on or off the microphone and the camera (when he turns the camera on, what the camera captures will be displayed on the host device's screen in this page). If the client mode is chosen, then the page lists the available host(s) that are connected to the same google account. After the user chooses what host to listen to, the page where what the host streams becomes available to the client device. The user can mute the sound and/or turn off the video.
