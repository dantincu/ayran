# Ayran WebMail Client

Create a webmail client app that connects to Gmail, Outlook and Yahoo. I want to be able to both read and compose / respond / forward to emails. Do not show images by default. Only show images for senders that the user has agreed to have images shown when reading messages from them. The navigation panel should be on the left and should be collapsable and expandable. It should contain entries for:

- Inbox
- Sent items
- All mail (or archived)
- Thrash folder
- Spam folder
- Custom folders defined by the user (or labels for Gmail) arranged in an expandable tree-view

Add basic search capability (by what subject contains and by what the body contains, both as either free text or regexp; by sender, by To/CC/BCC addresses; by date time sent: after and/or before). Add basic sort capability (by date time sent, by sender, by To/CC/BCC addresses). Add option to group messages by sender.

Showing the list of messages should be done using pagination (50 items per page). Icons for next and previous page should be provided, along with a label reading (page <number>) on which the user can click to select from a list of available page numbers. Load page numbers lazily. So when clicking on that label, a searchable dropdown should be provided that lists available page numbers lazily. The textbox of the dropdown should show the current page number. When the user edits the textbox, the new page number should be highlighted in the list and prev and next page numbers should be listed beside it. But this dropdown popover should only close when a user taps on an actual page number or outside of the popover (then the current page doesn't change).

Create the app as a react web app.
