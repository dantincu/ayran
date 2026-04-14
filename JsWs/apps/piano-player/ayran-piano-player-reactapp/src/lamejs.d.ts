declare module 'lamejs' {
  class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number)
    encodeBuffer(left: Int16Array, right?: Int16Array): Int16Array
    flush(): Int16Array
  }
  const lamejs: { Mp3Encoder: typeof Mp3Encoder }
  export default lamejs
}
