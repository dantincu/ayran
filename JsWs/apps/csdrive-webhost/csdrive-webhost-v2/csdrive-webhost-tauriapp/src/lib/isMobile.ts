/** True on Android and iOS: no relocatable data
 * folder, the file dialogs hand back content URIs instead of paths, and the webview can't
 * pass request bodies over the fast IPC channel. Read from the user agent because the page
 * is served over a custom protocol and has no other platform signal without an extra
 * backend call. */
export const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
