// CIDv1 for raw blobs, which is how AT Protocol addresses an avatar.
//
// This is the keystone of the zero-trust external quest. A Bluesky profile
// record says:
//
//   "avatar": { "ref": { "$link": "bafkreihhpqdyntku66him…" } }
//
// and that string is the hash OF THE BYTES, inside a record signed by that
// person's repo key. Our character PNG is a pure function of the DID, so
// "are you wearing your derived face?" is answerable by recomputing the image
// and comparing hashes — no oracle, no API to trust, nobody's word for it.
//
//   CIDv1 = multibase('b') + varint(0x01) + varint(0x55 raw) + 0x12 0x20 + sha256

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lower case, no padding — multibase 'b'. */
export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

/** The CID a blob of these exact bytes will have in an AT Proto repo. */
export async function rawCid(bytes: Uint8Array): Promise<string> {
  const digest = await sha256(bytes)
  const prefixed = new Uint8Array(4 + digest.length)
  prefixed[0] = 0x01 // CID version 1
  prefixed[1] = 0x55 // raw codec
  prefixed[2] = 0x12 // sha2-256
  prefixed[3] = 0x20 // 32 bytes
  prefixed.set(digest, 4)
  return `b${base32Encode(prefixed)}`
}

/** True when these bytes are the blob that CID names. */
export async function cidMatches(bytes: Uint8Array, cid: string): Promise<boolean> {
  return (await rawCid(bytes)) === cid
}
