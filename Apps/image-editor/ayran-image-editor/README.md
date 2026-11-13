# Ayran Image Editor

A small MS Paint-like editor that runs in the browser, with no build step and no dependencies. Open `index.html`
(directly from disk works).

- **Tools:** select / move / copy / cut / paste, pencil, brush, eraser (erases to transparency), fill, color picker,
  text, line, rectangle, ellipse. Left button paints with color 1, right button with color 2.
- **Transparency:** every color has an opacity; the palette's crossed swatch paints transparency; the image is shown
  over a checkerboard and saved as PNG.
- **Image:** new, open (button, drag & drop or paste), save PNG, undo/redo, resize (scale or canvas), crop to
  selection, flip, rotate, zoom (Ctrl+wheel).

## Remove background — in two steps

1. **Detect.** The editor samples the pixels along the image's edges and finds the color that dominates them
   (coarse color buckets, then the median of the winning bucket). It shows the result as a color code and a
   sample rectangle painted in that color, plus how much of the edge it matches.
   If it is wrong, *No, let me pick it in the image* lets you click the real background.
2. **Remove.** Only once you confirm, that color is subtracted: matching pixels connected to the edges become
   transparent (or all matching pixels — see *Removal options*), and the ring of anti-aliased pixels around them
   has the background color un-blended so no halo is left. Ctrl+Z undoes it.

The logic is in [js/bg-removal.js](js/bg-removal.js) (pure functions, shared by the browser and the tests).

## Tests

```
npm test
```
