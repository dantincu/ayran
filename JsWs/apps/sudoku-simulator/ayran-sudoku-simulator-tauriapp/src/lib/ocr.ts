import { createWorker } from "tesseract.js";
import { BOARD_SIZE, CELL_COUNT, createEmptyBoard, type Board } from "./sudoku";

export interface OcrCellResult {
  value: number | null;
  confidence: number;
}

export interface OcrResult {
  board: Board;
  cellResults: OcrCellResult[];
  /** Indices whose recognized value is a guess worth double-checking. */
  lowConfidenceIndices: number[];
}

const LOW_CONFIDENCE_THRESHOLD = 60;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Grayscale + simple threshold, in place, on a canvas's image data. */
function preprocess(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const value = gray > 150 ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  ctx.putImageData(imageData, 0, 0);
}

/** Runs OCR against a tightly-cropped screenshot of a 9x9 sudoku board. */
export async function recognizeBoardFromImage(imageSrc: string): Promise<OcrResult> {
  const img = await loadImage(imageSrc);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  preprocess(ctx, canvas.width, canvas.height);

  const cellWidth = canvas.width / BOARD_SIZE;
  const cellHeight = canvas.height / BOARD_SIZE;
  const padding = 0.12;

  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "123456789",
  });

  const board = createEmptyBoard();
  const cellResults: OcrCellResult[] = new Array(CELL_COUNT);
  const lowConfidenceIndices: number[] = [];

  try {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const index = row * BOARD_SIZE + col;

        const cellCanvas = document.createElement("canvas");
        const padX = cellWidth * padding;
        const padY = cellHeight * padding;
        cellCanvas.width = cellWidth - padX * 2;
        cellCanvas.height = cellHeight - padY * 2;
        const cellCtx = cellCanvas.getContext("2d")!;
        cellCtx.drawImage(
          canvas,
          col * cellWidth + padX,
          row * cellHeight + padY,
          cellCanvas.width,
          cellCanvas.height,
          0,
          0,
          cellCanvas.width,
          cellCanvas.height,
        );

        const {
          data: { text, confidence },
        } = await worker.recognize(cellCanvas);

        const digit = text.match(/[1-9]/)?.[0];
        const value = digit ? Number(digit) : null;

        board[index] = { value, isDark: false, bgColor: null };
        cellResults[index] = { value, confidence };
        if (value != null && confidence < LOW_CONFIDENCE_THRESHOLD) {
          lowConfidenceIndices.push(index);
        }
      }
    }
  } finally {
    await worker.terminate();
  }

  return { board, cellResults, lowConfidenceIndices };
}
