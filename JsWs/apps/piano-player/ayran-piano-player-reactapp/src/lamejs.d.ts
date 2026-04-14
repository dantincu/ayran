// lamejs is loaded as a global script via /lame.min.js in index.html
interface LameJsEncoder {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int16Array
  flush(): Int16Array
}
declare const lamejs: {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameJsEncoder
}
