// freeqworld/music — deterministic chiptune engine.
//
//   Theme  --compose-->  Score  --renderScore-->  Audio  --encodeWav-->  .wav
//   DID    --mint------>  Theme (unique per identity)

export * from './theory.ts'
export * from './score.ts'
export * from './instruments.ts'
export * from './synth.ts'
export * from './compose.ts'
export * from './themes.ts'
export * from './motif.ts'
export * from './mint.ts'
export * from './wav.ts'
export { rngFromString } from './seed.ts'
