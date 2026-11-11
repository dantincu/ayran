# Ayran Fav Tabs

Let's create a chromium browser extension for remembering specific browser tabs chosen by the user. When loading this extension and pinning it to the browser's top bar, clicking on its icon will either "remember" or "forget" the currently focused tab. Right clicking on it (or pressing a keyboard shortcut - pick something like [Ctrl+M F] or something similar) will open this extension's view tab that will list currently remembered tabs. When remembering a tab, its url, title and icon image should be remembered and updated when the user navigates that tab. Closing a tab will not remove it from our list (will not be forgotten when closed). Likewise, forgetting a tab will not close it. In this extension's view tab remembered tab heads will be listed similar to how the browser itself lists the tabs (that is, a close icon on the right, the icon on the left, then the title - and optionally the url just below the title, discarding the protocol, so starting with the domain; this option should be accessible through the settings popup modal that will open when clicking on a settings icon from the top bar of this extension's view tab). But instead of sizing tab heads to accomodate them to sit on the same line, all tab heads will have a fixed width (configurable from the settings popup modal, default being 200px). They will be listed horizontally and wrap on multiple lines. Left clicking on a tab head will focus its browser tab (if it's open) or open it in a new tab. Pressing the close icon for a tab head will just forget it (unlist it from our list) but not close its actual browser tab. Right-clicking on the tab head will show a context menu with the following entries:
 - Select (then the tab head will be selected and the select mode will be entered and a checkbox will be shown for every tab head; range-selecting and range-unselecting should be possible by holding the Shift key while clicking with the mouse on a checkbox)
 - Forget Tab
 - Close Tab
 - Forget and Close Tab

Middle clicking on the tab head (or right clicking on the tab head then choosing the option to close the tab) will close the browser tab without forgetting it. If there are 2 tabs with identical URLs they should both be rememberable separately.

What can the user do after selecting 1 or more tab heads:
 - Forget Selected Tabs
 - Close Selected Tabs
 - Forget and Close Selected Tabs

There should be an option to select all tab heads.

The tab heads will sit in the order they were remembered, with that order being editable during the select mode. To reorder tabs from the select mode the user will have 2 options:
 - drag and drop selected tabs (if there are more tab heads than fits in the browser viewport, dragging the selected tabs toward the bottom or top of the viewport will start scrolling the view down or up)
 - on the top bar there should be up and down arrows for shifting selected tab head's positions up and down 1 position, along with page up and page down arrows for shifting selected tab head's positions up and down 10 positions; right clicking on arrows will shift 3 positions and right clicking page arrows will shift 30 positions; and then besides the up, down, page up, page down buttons, there should be a "start" and "end" buttons to place selected tabs at the start or at the end of the list

Left-clicking on a tab head's icon will bring in a whole new view four our extension: only the clicked tab head will be shown at the top and below it a list of browser tabs having the same second level domain for the url that the clicked tab head has. Urls for these browser tabs will be shown along with their titles and icons. Then right-clicking a browser tab head from this list will bring in a context menu with the following options:
 - Switch to This Tab (will reassociate the previously clicked entry from our list with the chosen browser tab)

Regarding the list of matching browser tabs: for each such tab a colored label should be shown to indicate the level of match for the url:
 - Exact match (the urls are identical character by character); the color used will be light green
 - Equal (the urls are identical after ignoring redundant forward slashes, hashes and question marks); the color used will be dark green
 - Partial (same domain); the color used will be blue
 - Partial (same second level domain); no color should be used in this case, as we only show browser tabs whose urls match at least at this last level