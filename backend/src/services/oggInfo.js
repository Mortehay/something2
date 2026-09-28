// Pure checks on an OGG buffer, with no audio library (spec §2 "Every file is
// checked"). The box delivers OGG Vorbis; anything else -- a WAV master, an
// HTML error page, an empty body -- must fail the job loudly rather than be
// stored and then fail silently in a browser's decodeAudioData.
//
// Duration = granule position of the LAST page / sample rate. For Vorbis the
// granule is the PCM sample count at the end of that page, and the sample rate
// sits in the identification header (packet 1: 0x01 'vorbis', rate at +12).

const AUDIO_SIZE_CAPS = { music: 8 * 1024 * 1024, ambience: 8 * 1024 * 1024, sfx: 1024 * 1024 };
const OGGS = Buffer.from('OggS');

function vorbisSampleRate(buf) {
  const at = buf.indexOf(Buffer.from([0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])); // \x01vorbis
  if (at < 0 || at + 16 > buf.length) return null;
  return buf.readUInt32LE(at + 12);
}

function lastGranule(buf) {
  let pos = buf.lastIndexOf(OGGS);
  while (pos >= 0) {
    if (pos + 14 <= buf.length) {
      const g = buf.readBigInt64LE(pos + 6);
      if (g > 0n) return g;
    }
    pos = pos > 0 ? buf.lastIndexOf(OGGS, pos - 1) : -1;
  }
  return null;
}

function inspectOgg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28 || !buf.subarray(0, 4).equals(OGGS)) {
    return { ok: false, error: 'not an OGG file (expected OggS magic)' };
  }
  const sampleRate = vorbisSampleRate(buf);
  if (!sampleRate) return { ok: false, error: 'OGG has no Vorbis identification header' };
  const granule = lastGranule(buf);
  if (!granule) return { ok: false, error: 'OGG has no audio pages (duration 0)' };
  const durationMs = Math.round(Number(granule) * 1000 / sampleRate);
  if (!(durationMs > 0)) return { ok: false, error: 'OGG duration is 0' };
  return { ok: true, sampleRate, durationMs };
}

function checkClipBuffer(buf, kind) {
  const cap = AUDIO_SIZE_CAPS[kind];
  if (!cap) return { ok: false, error: `unknown clip kind '${kind}'` };
  if (buf.length > cap) {
    return { ok: false, error: `clip too large: ${buf.length} bytes, cap for ${kind} is ${cap}` };
  }
  return inspectOgg(buf);
}

module.exports = { inspectOgg, checkClipBuffer, AUDIO_SIZE_CAPS };
