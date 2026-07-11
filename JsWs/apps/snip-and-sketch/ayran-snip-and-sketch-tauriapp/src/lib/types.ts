export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SavedCrop {
  id: string;
  name: string;
  rect: Rect;
  /** dimensions of the image the rect was captured against, so it can be scaled/clamped sanely */
  sourceWidth: number;
  sourceHeight: number;
  createdAt: number;
}

export interface CropHistoryEntry {
  /** the rect (in the previous image's coordinate space) that produced this step */
  rect: Rect;
  /** data URL of the image *before* this crop was applied */
  previousImageDataUrl: string;
}

export interface AppState {
  id: "current";
  imageName: string | null;
  /** data URL of the image as it currently stands (after all applied crops) */
  currentImageDataUrl: string | null;
  history: CropHistoryEntry[];
}
