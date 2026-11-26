// Each line is a mistake the declarations must catch: tsc must report exactly these errors.
import { encode } from 'open3dpc';
import { Open3DPCReader } from 'open3dpc/reader';

new Open3DPCReader({ geometries: ['4x6'] });   // shapes are [rows, columns]
new Open3DPCReader({ payloadLength: 14 });     // the option is payloadLengths
encode(9999, 4, 6);                            // the payload is bits, from bitsFromInteger
