# Ayran Image Editor

Let's create an image editor similar to MS Paint. The editor should support transparency. Let's implement the feature to remove an image's background. But instead of doing it like all editors do (simply choose the option and then let the editor do its job) let's do it in 2 steps:
 - when the user chooses this option, our editor should first detect the background color, the result being 1 color code; that color code together with the actual color painted as a sample rectangle should be shown to the user
 - when the user confirms that the detected background color is indeed the real background color, our editor should substract that color from the image's background