// builder/ymt-writer.js
// Writes GTA V ped clothing ".ymt" files, and reads them back, in pure JavaScript.
//
// A freemode clothing collection is described to the game by one .ymt: an RSC7
// "meta" resource (version 2) holding a CPedVariationInfo structure. It says
// which component slots and props the collection has, how many drawables and
// textures each one carries, and a handful of per-item values. A pack that
// ships a byte copy of another pack's .ymt claims that pack's collection name
// and file names, so two such packs collide. This module builds the .ymt of a
// new collection from a description of what it holds instead, and needs no
// .NET tool to do it.
//
//   buildYmt(item, options)     one garment or one prop      -> .ymt bytes
//   buildPedYmt(doc, options)   any CPedVariationInfo "doc"  -> .ymt bytes
//   readPedYmt(file)            .ymt bytes                   -> the same doc
//
// A doc is a plain-object mirror of the structure, with the field names
// CodeWalker prints in its XML (aComponentData3, compInfos, propInfo, ...).
//
// Layouts. The same content can be arranged in the resource pages in more than
// one way. 'codewalker' (the default) is byte for byte what CodeWalker's XML
// importer builds, decompressed pages and header words alike, so every output
// can be checked against a reference tool. 'ragelib' is the arrangement of the
// builder that made the two collections this project has already seen load in
// game; it is kept as a fallback, only for content that fits one 8192-byte
// page and only for the kinds of content that builder has been seen to write.
//
// Pure module: node:zlib and nothing else. No file system, no FiveM globals,
// no clock, no randomness, and the arguments are never modified. It is loaded
// with require() (not a server_script), so it needs no IIFE wrapper.
//
// readPedYmt takes owner-supplied files, so every pointer, count and offset is
// bounds checked and a malformed file fails with code 'bad_ymt', not a crash.
//
// Written from the file-format knowledge documented by the CodeWalker project
// (MIT) and checked against CodeWalker's output; the 'ragelib' arrangement was
// measured on files built with gta-toolkit / RageLib (MIT). No code from
// either is included.

'use strict';

const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// 1. Format constants and schema tables
// ---------------------------------------------------------------------------

const RSC7_MAGIC = 0x37435352;          // the bytes "RSC7"
const RSC7_HEADER_SIZE = 16;
const RSC7_HEADER = Object.freeze({ MAGIC: 0, VERSION: 4, SYSTEM_FLAGS: 8, GRAPHICS_FLAGS: 12 });
const META_RESOURCE_VERSION = 2;
// The resource version is split over the two flag words: its high nibble sits
// in the top of the system flags (0), its low nibble in the top of the
// graphics flags (2). A meta has no graphics pages, so that is the whole word.
const GRAPHICS_FLAGS = 0x20000000;
const SYSTEM_BASE = 0x50000000;         // pointers are this plus an offset into the system pages
const BASE_PAGE_SIZE = 0x2000;

// A ped .ymt is small: the largest one in the game has 0x8000 bytes of pages,
// and the largest collection the game's one-byte counters can address (12
// slots x 256 drawables x 26 textures, plus 255 props x 26 textures) needs
// 0xC0000. The cap is a little over twice that. It is what bounds the reader
// on a hostile file: a decoded record takes many times its size in memory (a
// 3-byte texture becomes an object of some 60 bytes), so pages full of small
// records cost about twenty times their size. It is the same for the writer,
// so the reader accepts everything the writer can produce.
const MAX_PAGES_BYTES = 0x200000;

const META_HEADER_SIZE = 0x70;
const META_MAGIC = 0x50524430;          // constant in every meta resource examined
const META_UNKNOWN_14 = 0x0079;         // likewise
// Offsets inside the meta header. Everything not listed stays zero.
const META_HEADER = Object.freeze({
    FILE_VFT: 0x00,
    FILE_UNKNOWN: 0x04,
    PAGES_INFO_POINTER: 0x08,
    MAGIC: 0x10,
    UNKNOWN_14: 0x14,
    ROOT_BLOCK_INDEX: 0x1C,             // 1-based index into the data block table
    STRUCT_INFOS_POINTER: 0x20,
    ENUM_INFOS_POINTER: 0x28,
    DATA_BLOCKS_POINTER: 0x30,
    NAME_POINTER: 0x38,
    STRUCT_INFOS_COUNT: 0x48,
    ENUM_INFOS_COUNT: 0x4A,
    DATA_BLOCKS_COUNT: 0x4C
});

// The records the header points at: their sizes and the offsets inside them.
const PAGES_INFO_HEADER_SIZE = 16;      // then 8 zero bytes per page
const PAGES_INFO_PAGE_COUNT_OFFSET = 8;
const STRUCT_INFO_SIZE = 32;
const STRUCT_INFO = Object.freeze({ NAME: 0, KEY: 4, UNKNOWN_8: 8, ENTRIES_POINTER: 16, SIZE: 24, ENTRY_COUNT: 30 });
const STRUCT_ENTRY_SIZE = 16;
const STRUCT_ENTRY = Object.freeze({ NAME: 0, OFFSET: 4, DATA_TYPE: 8, REF_INDEX: 10, REF_KEY: 12 });
const ENUM_INFO_SIZE = 24;
const ENUM_INFO = Object.freeze({ NAME: 0, KEY: 4, ENTRIES_POINTER: 8, ENTRY_COUNT: 16 });
const ENUM_ENTRY_SIZE = 8;
const ENUM_ENTRY = Object.freeze({ NAME: 0, VALUE: 4 });
const DATA_BLOCK_INFO_SIZE = 16;
const DATA_BLOCK_INFO = Object.freeze({ TYPE: 0, LENGTH: 4, POINTER: 8 });

// An array field is a 16-byte header inside its structure; the elements live
// in a data block. The header's pointer is packed: the block's 1-based number
// in the low 12 bits, the byte offset inside that block in the 20 bits above.
const ARRAY_HEADER = Object.freeze({ POINTER: 0, COUNT: 8, CAPACITY: 10 });
const ARRAY_BLOCK_BITS = 12;
const ARRAY_BLOCK_MASK = (1 << ARRAY_BLOCK_BITS) - 1;
const ARRAY_PADDING = 16;               // each array is zero-padded to this as a whole
const MAX_ARRAY_COUNT = 0xFFFF;         // the header counts in 16 bits

const ARRAYINFO_HASH = 0x100;           // entry name of a row that only gives an array's element type
// CodeWalker keeps appending arrays to a block until it has reached this size,
// then opens another block of the same type. Needed to match it byte for byte.
const BLOCK_APPEND_LIMIT = 0x4000;

// Field data types (the dataType byte of a structure entry) used by the ped structures.
const DATA_TYPE = Object.freeze({
    BOOL: 0x01,                         // 1 byte, 0 or 1
    STRUCT: 0x05,                       // another structure, stored inline
    U8: 0x11,
    U16: 0x13,
    U32: 0x15,
    FLOAT: 0x21,                        // IEEE single; only an array element here
    HASH: 0x4A,                         // 4-byte joaat value
    FIXED_ARRAY: 0x50,                  // fixed number of elements, stored inline
    ARRAY: 0x52,                        // 16-byte header; the elements live in a data block
    INT_ENUM: 0x62,                     // 4-byte enum value
    INT_FLAGS1: 0x63,                   // 4-byte bit mask, bit n = the enum entry with value n
    SHORT_FLAGS: 0x64,                  // 2-byte bit mask
    INT_FLAGS2: 0x65                    // 4-byte bit mask with no enum behind it
});

const SCALAR_BYTES = Object.freeze({
    [DATA_TYPE.BOOL]: 1, [DATA_TYPE.U8]: 1, [DATA_TYPE.U16]: 2, [DATA_TYPE.U32]: 4, [DATA_TYPE.FLOAT]: 4,
    [DATA_TYPE.HASH]: 4, [DATA_TYPE.INT_ENUM]: 4, [DATA_TYPE.INT_FLAGS1]: 4, [DATA_TYPE.SHORT_FLAGS]: 2,
    [DATA_TYPE.INT_FLAGS2]: 4
});

// The three enums a ped .ymt can describe. Entries: [name, value].
const ENUM_TABLE = [
    { name: 'ePedVarComp', key: 0xCEF3CD96, entries: [
        ['PV_COMP_INVALID', -1], ['PV_COMP_HEAD', 0], ['PV_COMP_BERD', 1], ['PV_COMP_HAIR', 2],
        ['PV_COMP_UPPR', 3], ['PV_COMP_LOWR', 4], ['PV_COMP_HAND', 5], ['PV_COMP_FEET', 6],
        ['PV_COMP_TEEF', 7], ['PV_COMP_ACCS', 8], ['PV_COMP_TASK', 9], ['PV_COMP_DECL', 10],
        ['PV_COMP_JBIB', 11], ['PV_COMP_MAX', 12]
    ] },
    { name: 'ePropRenderFlags', key: 0x5C8052A1, entries: [
        ['PRF_ALPHA', 0], ['PRF_DECAL', 1], ['PRF_CUTOUT', 2]
    ] },
    { name: 'eAnchorPoints', key: 0x4E0B7113, entries: [
        ['ANCHOR_HEAD', 0], ['ANCHOR_EYES', 1], ['ANCHOR_EARS', 2], ['ANCHOR_MOUTH', 3],
        ['ANCHOR_LEFT_HAND', 4], ['ANCHOR_RIGHT_HAND', 5], ['ANCHOR_LEFT_WRIST', 6], ['ANCHOR_RIGHT_WRIST', 7],
        ['ANCHOR_HIP', 8], ['ANCHOR_LEFT_FOOT', 9], ['ANCHOR_RIGHT_FOOT', 10], ['ANCHOR_PH_L_HAND', 11],
        ['ANCHOR_PH_R_HAND', 12], ['NUM_ANCHORS', 13]
    ] }
];

// The eleven structures, exactly as every file that contains them describes
// them (Rockstar's, CodeWalker's and RageLib's copies are identical).
// Rows: [entry name, offset in the structure, data type, refIndex, refKey].
//   - A row named ARRAYINFO is not a field: it gives the element type of the
//     array row that points at it through refIndex (an index into these rows).
//   - refKey is the element count of a FIXED_ARRAY, or the name of the
//     structure / enum a STRUCT, flags or enum row refers to.
//   - refIndex on the flags rows (32, 16, 3) is copied as found; the game's
//     use of it is not known.
// "key" and "unk8" are per-structure constants of unknown meaning, also copied.
const ARRAYINFO = null;
const STRUCTURE_TABLE = [
    { name: 'CPVTextureData', key: 0xFEAC7FE2, unk8: 0x000, size: 3, rows: [
        ['texId', 0, DATA_TYPE.U8, 0, 0],
        ['distribution', 1, DATA_TYPE.U8, 0, 0]
    ] },
    { name: 'CPVDrawblData__CPVClothComponentData', key: 0x1E55BE07, unk8: 0x000, size: 24, rows: [
        ['ownsCloth', 0, DATA_TYPE.BOOL, 0, 0]
    ] },
    { name: 'CPVDrawblData', key: 0x076536BE, unk8: 0x300, size: 48, rows: [
        ['propMask', 0, DATA_TYPE.U8, 0, 0],
        ['numAlternatives', 1, DATA_TYPE.U8, 0, 0],
        [ARRAYINFO, 0, DATA_TYPE.STRUCT, 0, 'CPVTextureData'],
        ['aTexData', 8, DATA_TYPE.ARRAY, 2, 0],
        ['clothData', 24, DATA_TYPE.STRUCT, 0, 'CPVDrawblData__CPVClothComponentData']
    ] },
    { name: 'CPVComponentData', key: 0x78A5141F, unk8: 0x300, size: 24, rows: [
        ['numAvailTex', 0, DATA_TYPE.U8, 0, 0],
        [ARRAYINFO, 0, DATA_TYPE.STRUCT, 0, 'CPVDrawblData'],
        ['aDrawblData3', 8, DATA_TYPE.ARRAY, 1, 0]
    ] },
    { name: 'CPedSelectionSet', key: 0xB9FBC547, unk8: 0x200, size: 48, rows: [
        ['name', 0, DATA_TYPE.HASH, 0, 0],
        [ARRAYINFO, 0, DATA_TYPE.U8, 0, 0],
        ['compDrawableId', 4, DATA_TYPE.FIXED_ARRAY, 1, 12],
        [ARRAYINFO, 0, DATA_TYPE.U8, 0, 0],
        ['compTexId', 16, DATA_TYPE.FIXED_ARRAY, 3, 12],
        [ARRAYINFO, 0, DATA_TYPE.U8, 0, 0],
        ['propAnchorId', 28, DATA_TYPE.FIXED_ARRAY, 5, 6],
        [ARRAYINFO, 0, DATA_TYPE.U8, 0, 0],
        ['propDrawableId', 34, DATA_TYPE.FIXED_ARRAY, 7, 6],
        [ARRAYINFO, 0, DATA_TYPE.U8, 0, 0],
        ['propTexId', 40, DATA_TYPE.FIXED_ARRAY, 9, 6]
    ] },
    { name: 'CComponentInfo', key: 0xDC2BA2D2, unk8: 0x200, size: 48, rows: [
        ['pedXml_audioID', 0, DATA_TYPE.HASH, 0, 0],
        ['pedXml_audioID2', 4, DATA_TYPE.HASH, 0, 0],
        [ARRAYINFO, 0, DATA_TYPE.FLOAT, 0, 0],
        ['pedXml_expressionMods', 8, DATA_TYPE.FIXED_ARRAY, 2, 5],
        ['flags', 28, DATA_TYPE.U32, 0, 0],
        ['inclusions', 32, DATA_TYPE.INT_FLAGS2, 32, 0],
        ['exclusions', 36, DATA_TYPE.INT_FLAGS2, 32, 0],
        ['pedXml_vfxComps', 40, DATA_TYPE.SHORT_FLAGS, 16, 'ePedVarComp'],
        ['pedXml_flags', 42, DATA_TYPE.U16, 0, 0],
        ['pedXml_compIdx', 44, DATA_TYPE.U8, 0, 0],
        ['pedXml_drawblIdx', 45, DATA_TYPE.U8, 0, 0]
    ] },
    { name: 'CPedPropTexData', key: 0xA4F19689, unk8: 0x200, size: 12, rows: [
        ['inclusions', 0, DATA_TYPE.INT_FLAGS2, 32, 0],
        ['exclusions', 4, DATA_TYPE.INT_FLAGS2, 32, 0],
        ['texId', 8, DATA_TYPE.U8, 0, 0],
        ['inclusionId', 9, DATA_TYPE.U8, 0, 0],
        ['exclusionId', 10, DATA_TYPE.U8, 0, 0],
        ['distribution', 11, DATA_TYPE.U8, 0, 0]
    ] },
    { name: 'CPedPropMetaData', key: 0x78FB596E, unk8: 0x300, size: 56, rows: [
        ['audioId', 0, DATA_TYPE.HASH, 0, 0],
        [ARRAYINFO, 0, DATA_TYPE.FLOAT, 0, 0],
        ['expressionMods', 4, DATA_TYPE.FIXED_ARRAY, 1, 5],
        [ARRAYINFO, 0, DATA_TYPE.STRUCT, 0, 'CPedPropTexData'],
        ['texData', 24, DATA_TYPE.ARRAY, 3, 0],
        ['renderFlags', 40, DATA_TYPE.INT_FLAGS1, 3, 'ePropRenderFlags'],
        ['propFlags', 44, DATA_TYPE.U32, 0, 0],
        ['flags', 48, DATA_TYPE.U16, 0, 0],
        ['anchorId', 50, DATA_TYPE.U8, 0, 0],
        ['propId', 51, DATA_TYPE.U8, 0, 0],
        ['stickyness', 52, DATA_TYPE.U8, 0, 0]
    ] },
    { name: 'CAnchorProps', key: 0x180E0DA4, unk8: 0x300, size: 24, rows: [
        [ARRAYINFO, 0, DATA_TYPE.U8, 0, 0],
        ['props', 0, DATA_TYPE.ARRAY, 0, 0],
        ['anchor', 16, DATA_TYPE.INT_ENUM, 0, 'eAnchorPoints']
    ] },
    { name: 'CPedPropInfo', key: 0x6AD7318B, unk8: 0x300, size: 40, rows: [
        ['numAvailProps', 0, DATA_TYPE.U8, 0, 0],
        [ARRAYINFO, 0, DATA_TYPE.STRUCT, 0, 'CPedPropMetaData'],
        ['aPropMetaData', 8, DATA_TYPE.ARRAY, 1, 0],
        [ARRAYINFO, 0, DATA_TYPE.STRUCT, 0, 'CAnchorProps'],
        ['aAnchors', 24, DATA_TYPE.ARRAY, 3, 0]
    ] },
    { name: 'CPedVariationInfo', key: 0xF0423679, unk8: 0x300, size: 112, rows: [
        ['bHasTexVariations', 0, DATA_TYPE.BOOL, 0, 0],
        ['bHasDrawblVariations', 1, DATA_TYPE.BOOL, 0, 0],
        ['bHasLowLODs', 2, DATA_TYPE.BOOL, 0, 0],
        ['bIsSuperLOD', 3, DATA_TYPE.BOOL, 0, 0],
        [ARRAYINFO, 0, DATA_TYPE.U8, 0, 0],
        ['availComp', 4, DATA_TYPE.FIXED_ARRAY, 4, 12],
        [ARRAYINFO, 0, DATA_TYPE.STRUCT, 0, 'CPVComponentData'],
        ['aComponentData3', 16, DATA_TYPE.ARRAY, 6, 0],
        [ARRAYINFO, 0, DATA_TYPE.STRUCT, 0, 'CPedSelectionSet'],
        ['aSelectionSets', 32, DATA_TYPE.ARRAY, 8, 0],
        [ARRAYINFO, 0, DATA_TYPE.STRUCT, 0, 'CComponentInfo'],
        ['compInfos', 48, DATA_TYPE.ARRAY, 10, 0],
        ['propInfo', 64, DATA_TYPE.STRUCT, 0, 'CPedPropInfo'],
        ['dlcName', 104, DATA_TYPE.HASH, 0, 0]
    ] }
];

const ROOT_STRUCT_NAME = 'CPedVariationInfo';
const AVAIL_COMP_SLOTS = 12;
const SLOT_ABSENT = 255;                // availComp value of a slot the collection does not have

// What distinguishes the two layouts besides block placement.
const CODEWALKER = Object.freeze({
    fileVft: 0x405BC808,
    fileUnknown: 1,
    // CodeWalker assigns positions while its pages-info object still claims
    // 128 pages (16 + 8 * 128 bytes) and only then writes the real, short one.
    pagesInfoLength: 0x410,
    alignment: 16,                      // every block starts on a 16-byte boundary
    slack: 16                           // and only fits a page with this much room to spare
});
const RAGELIB = Object.freeze({
    fileVft: 0,
    fileUnknown: 0,
    pagesInfoLength: PAGES_INFO_HEADER_SIZE + 8,
    alignment: 64,                      // every block starts on a 64-byte boundary ...
    gap: 64,                            // ... at least 64 bytes after the previous one ends
    systemFlags: 0x00020000,            // one 0x2000 page, spelled the way the game's own files spell it
    // RageLib describes all three enums, used or not, in this order.
    enumOrder: Object.freeze(['ePedVarComp', 'ePropRenderFlags', 'eAnchorPoints'])
});

// Public tables: texture file race suffix -> texId, component slot -> file
// prefix, prop anchor -> file prefix and enum name. The prefixes are the ones
// the game's own files carry (p_lwrist / p_rwrist for anchors 6 and 7).
// garment-prepare.js still has an older table of its own that says p_lhand /
// p_rhand there; when the two are joined, these are the ones to keep.
const RACE_TEX_ID = Object.freeze({ uni: 0, whi: 1, bla: 2, chi: 3, lat: 4, ara: 5, pak: 10 });
const COMPONENT_PREFIXES = Object.freeze(['head', 'berd', 'hair', 'uppr', 'lowr', 'hand', 'feet', 'teef', 'accs', 'task', 'decl', 'jbib']);
const PROP_ANCHORS = Object.freeze({
    0: Object.freeze({ prefix: 'p_head', name: 'ANCHOR_HEAD' }),
    1: Object.freeze({ prefix: 'p_eyes', name: 'ANCHOR_EYES' }),
    2: Object.freeze({ prefix: 'p_ears', name: 'ANCHOR_EARS' }),
    6: Object.freeze({ prefix: 'p_lwrist', name: 'ANCHOR_LEFT_WRIST' }),
    7: Object.freeze({ prefix: 'p_rwrist', name: 'ANCHOR_RIGHT_WRIST' })
});
const MAX_TEXTURES = 26;                // texture letters a..z

// ---------------------------------------------------------------------------
// 2. joaat
// ---------------------------------------------------------------------------

// Jenkins one-at-a-time over the UTF-8 bytes of the text exactly as given.
// Structure, field and enum names are hashed this way (case matters for them).
function joaatExact(text) {
    const bytes = Buffer.from(text, 'utf8');
    let hash = 0;
    for (let i = 0; i < bytes.length; i += 1) {
        hash = (hash + bytes[i]) >>> 0;
        hash = (hash + (hash << 10)) >>> 0;
        hash = (hash ^ (hash >>> 6)) >>> 0;
    }
    hash = (hash + (hash << 3)) >>> 0;
    hash = (hash ^ (hash >>> 11)) >>> 0;
    hash = (hash + (hash << 15)) >>> 0;
    return hash;
}

// The game's name hash: the same over the lower-cased text, as an unsigned
// 32-bit number. Collection names, audio names and the like are stored this way.
function joaat(text) {
    // A number here is almost always a hash that was computed already; turning
    // it into text and hashing its digits would quietly give a different one.
    if (typeof text !== 'string') throw new TypeError(`ymt-writer: joaat takes a string, got ${show(text)}`);
    return joaatExact(text.toLowerCase());
}

const HASH_NONE = joaat('none');        // 0x1D632BA1, the game's "no sound" audio id

// The tables above, resolved once at load: hashes computed, entry rows turned
// into the 16 raw bytes the file carries, and a per-field view for the code
// that validates, encodes and decodes structure instances.
const ENUMS = new Map(ENUM_TABLE.map(definition => [definition.name, {
    name: definition.name,
    nameHash: joaatExact(definition.name),
    key: definition.key,
    entries: definition.entries.map(([name, value]) => ({ nameHash: joaatExact(name), value }))
}]));

const STRUCTS = new Map(STRUCTURE_TABLE.map(definition => [definition.name, {
    name: definition.name,
    nameHash: joaatExact(definition.name),
    key: definition.key,
    unk8: definition.unk8,
    size: definition.size,
    entryCount: definition.rows.length,
    entryBytes: Buffer.alloc(STRUCT_ENTRY_SIZE * definition.rows.length),
    fields: [],
    fieldNames: new Set(),
    derive: null                        // set in section 3 for the structures that own derived fields
}]));

// A field is one of four kinds:
//   scalar      `type` is its data type (and `enum` the enum it refers to, if any)
//   struct      `struct` is the structure stored inline
//   fixedArray  `count` scalars of `elementType`, stored inline
//   array       a header here, the elements in a data block of `blockType`,
//               `stride` bytes each: structures (`struct`) or scalars (`elementType`)
// Every field object carries every property, the ones its kind does not use
// included: a lookup of one of them can then never fall through to a prototype.
for (const definition of STRUCTURE_TABLE) {
    const struct = STRUCTS.get(definition.name);
    definition.rows.forEach(([name, offset, type, refIndex, refKey], index) => {
        const at = STRUCT_ENTRY_SIZE * index;
        struct.entryBytes.writeUInt32LE(name === ARRAYINFO ? ARRAYINFO_HASH : joaatExact(name), at + STRUCT_ENTRY.NAME);
        struct.entryBytes.writeUInt32LE(offset, at + STRUCT_ENTRY.OFFSET);
        struct.entryBytes.writeUInt8(type, at + STRUCT_ENTRY.DATA_TYPE);
        struct.entryBytes.writeUInt16LE(refIndex, at + STRUCT_ENTRY.REF_INDEX);
        struct.entryBytes.writeUInt32LE(typeof refKey === 'string' ? joaatExact(refKey) : refKey, at + STRUCT_ENTRY.REF_KEY);
        if (name === ARRAYINFO) return;

        const field = {
            name, offset, kind: 'scalar',
            type: null, enum: null, struct: null, elementType: null, count: 0, blockType: 0, stride: 0,
            // The rules of section 3 for a field that the doc leaves out.
            required: false, derived: false, fallback: undefined, holdsTextures: false
        };
        if (type === DATA_TYPE.STRUCT) {
            field.kind = 'struct';
            field.struct = STRUCTS.get(refKey);
        } else if (type === DATA_TYPE.FIXED_ARRAY) {
            field.kind = 'fixedArray';
            field.elementType = definition.rows[refIndex][2];
            field.count = refKey;
        } else if (type === DATA_TYPE.ARRAY) {
            const [, , elementType, , elementKey] = definition.rows[refIndex];
            field.kind = 'array';
            if (elementType === DATA_TYPE.STRUCT) {
                field.struct = STRUCTS.get(elementKey);
                field.blockType = field.struct.nameHash;
                field.stride = field.struct.size;
            } else {
                // Raw values live in a block "named" after their data type
                // (0x11 for the bytes of CAnchorProps.props, the only such array).
                field.elementType = elementType;
                field.blockType = elementType;
                field.stride = SCALAR_BYTES[elementType];
            }
        } else {
            field.type = type;
            field.enum = typeof refKey === 'string' ? ENUMS.get(refKey) : null;
        }
        struct.fields.push(field);
        struct.fieldNames.add(name);
    });
}

const ROOT = STRUCTS.get(ROOT_STRUCT_NAME);
const STRUCT_BY_HASH = new Map([...STRUCTS.values()].map(struct => [struct.nameHash, struct]));

// Looks a field up by 'Structure.field'. The policy tables of sections 3 and 8
// name fields this way; a key that names none stops the module from loading,
// where it would otherwise be a rule that silently never applies.
function fieldOf(key) {
    const [structName, fieldName] = key.split('.');
    const struct = STRUCTS.get(structName);
    const field = struct && struct.fields.find(candidate => candidate.name === fieldName);
    if (!field) throw new Error(`ymt-writer: table key ${key} names no field`);
    return field;
}

// ---------------------------------------------------------------------------
// 3. Document validation and normalisation
// ---------------------------------------------------------------------------
// buildPedYmt accepts a partial doc. This stage checks every value and returns
// a complete copy (the argument is left alone): an omitted field gets a
// default, a few are computed from the rest, and a few have to be given.

// What an omitted field becomes when that is not 0 / false / empty. Taken from
// Rockstar's own files: every drawable has the lowest propMask bit set, every
// texture has distribution 255, and an audio id is never 0 ("none" means no
// sound).
const FIELD_DEFAULTS = new Map([
    ['CPVDrawblData.propMask', 1],
    ['CPVTextureData.distribution', 255],
    ['CPedPropTexData.distribution', 255],
    ['CComponentInfo.pedXml_audioID', HASH_NONE],
    ['CComponentInfo.pedXml_audioID2', HASH_NONE],
    ['CPedPropMetaData.audioId', HASH_NONE]
]);

// Omitted fields that are computed from the rest of the doc (the derive* functions below).
const DERIVED_FIELDS = [
    'CPedVariationInfo.availComp',
    'CPedVariationInfo.compInfos',
    'CPedVariationInfo.dlcName',
    'CPVComponentData.numAvailTex',
    'CPedPropInfo.numAvailProps',
    'CPedPropInfo.aAnchors',
    'CPedPropMetaData.propId',
    'CPedPropTexData.texId'
];

// Fields with neither: a guess would silently put an item on the wrong slot or
// anchor, and no game file shows what an "unset" selection-set entry holds.
const REQUIRED_FIELDS = [
    'CComponentInfo.pedXml_compIdx',
    'CComponentInfo.pedXml_drawblIdx',
    'CPedPropMetaData.anchorId',
    'CAnchorProps.anchor',
    'CPedSelectionSet.compDrawableId',
    'CPedSelectionSet.compTexId',
    'CPedSelectionSet.propAnchorId',
    'CPedSelectionSet.propDrawableId',
    'CPedSelectionSet.propTexId'
];

// The two arrays that hold textures. A texture is found by a file name that
// carries its letter (jbib_diff_000_a_uni.ytd ... jbib_diff_000_z_uni.ytd), so
// a 27th entry would describe a texture no file can be named for, and the
// game's own files stop at exactly 26 for drawables and props alike. The file
// format has no such limit (CodeWalker builds 27 without complaint), which is
// why it has to be enforced here. Only this upper bound is enforced: an empty
// texture list, which no game file has either, is something the format and
// CodeWalker allow and a mirror of a file must be able to write.
const TEXTURE_ARRAYS = ['CPVDrawblData.aTexData', 'CPedPropMetaData.texData'];

for (const [key, value] of FIELD_DEFAULTS) fieldOf(key).fallback = value;
for (const key of DERIVED_FIELDS) fieldOf(key).derived = true;
for (const key of REQUIRED_FIELDS) fieldOf(key).required = true;
for (const key of TEXTURE_ARRAYS) fieldOf(key).holdsTextures = true;

function specError(field, problem) {
    const error = new Error(`ymt-writer: ${field} ${problem}`);
    error.code = 'bad_ymt_spec';
    error.field = field;
    return error;
}

function tooLarge() {
    return specError('doc', `is too large: its pages would exceed ${MAX_PAGES_BYTES} bytes`);
}

// A plain data object. Maps, Sets, Dates and the like are objects too, but
// they carry their content where a field lookup does not find it, so they
// would be read as "every field omitted".
function isObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
}

function isMissing(value) {
    return value === undefined || value === null;
}

// Reads one input. Only an object's own properties count as given: a value
// that is merely inherited (which is where a prototype-pollution bug anywhere
// in the process would put one) is not something the caller said.
function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

// A short description of a rejected value for an error message. Text is
// quoted, cut short and escaped down to printable ASCII: it can come from
// anywhere (a file name, say), and a message is often written to a console.
const SHOWN_CHARACTERS = 40;
function show(value) {
    if (typeof value === 'string') {
        const start = JSON.stringify(value.slice(0, SHOWN_CHARACTERS))
            .replace(/[^\x20-\x7E]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
        return value.length > SHOWN_CHARACTERS ? `${start}...` : start;
    }
    if (typeof value === 'bigint') return 'a BigInt';
    if (typeof value === 'symbol') return 'a symbol';
    if (typeof value === 'function') return 'a function';
    if (Array.isArray(value)) return `an array of ${value.length}`;
    if (value !== null && typeof value === 'object') return 'an object';
    return String(value);
}

// A key on its way into a field path. Field, option and item names are plain
// words; a key that is not one is shown like any other rejected text.
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
function showKey(key) {
    return PLAIN_KEY.test(key) ? key : show(key);
}

function hex32(value) {
    return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

function normaliseInteger(value, max, path) {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw specError(path, `must be an integer 0..${max}, got ${show(value)}`);
    }
    return value;
}

// CodeWalker prints a hash it has no name for as "hash_" and its hex digits.
// That text is a number, not a name: hashing it would store some other number.
const HASH_SPELLING = /^hash_([0-9a-f]{1,8})$/i;

function normaliseScalar(type, value, path) {
    if (type === DATA_TYPE.BOOL) {
        if (typeof value !== 'boolean') throw specError(path, `must be true or false, got ${show(value)}`);
        return value;
    }
    if (type === DATA_TYPE.FLOAT) {
        const single = typeof value === 'number' ? Math.fround(value) : NaN;
        if (!Number.isFinite(single)) throw specError(path, `must be a finite number that fits a 32-bit float, got ${show(value)}`);
        // Two ways to arrive at a negative zero, and CodeWalker treats them
        // differently: it reads the text "-0" as 0, but for a negative number
        // too small for a single it stores the -0 that number rounds to.
        return Object.is(value, -0) ? 0 : single;
    }
    if (type === DATA_TYPE.HASH) {
        if (typeof value === 'string') {
            const spelled = HASH_SPELLING.exec(value);
            if (spelled) throw specError(path, `is the way CodeWalker spells a number, not a name to hash: give 0x${spelled[1].toUpperCase()} instead`);
            return joaat(value);
        }
        if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
            throw specError(path, `must be a number 0..4294967295 or a name to hash, got ${show(value)}`);
        }
        return value;
    }
    return normaliseInteger(value, 2 ** (8 * SCALAR_BYTES[type]) - 1, path);
}

function requireArray(value, path) {
    if (!Array.isArray(value)) throw specError(path, `must be an array, got ${show(value)}`);
}

function normaliseFixedArray(field, value, path) {
    requireArray(value, path);
    if (value.length !== field.count) throw specError(path, `must have exactly ${field.count} entries, got ${value.length}`);
    // Array.from, not map: it also visits the holes of a sparse array, which then fail the element check.
    return Array.from(value, (element, index) => normaliseScalar(field.elementType, element, `${path}[${index}]`));
}

// `budget.bytes` counts what the arrays accepted so far will occupy in the pages.
function normaliseArray(field, value, path, budget) {
    requireArray(value, path);
    if (field.holdsTextures && value.length > MAX_TEXTURES) {
        throw specError(path, `has ${value.length} entries; a drawable or a prop has at most ${MAX_TEXTURES} textures (their files are lettered a..z)`);
    }
    if (value.length > MAX_ARRAY_COUNT) throw specError(path, `has ${value.length} entries; an array holds at most ${MAX_ARRAY_COUNT}`);
    // Counted before the entries are looked at, so that an oversized doc is
    // refused after work in proportion to the limit, not to the doc: one list
    // of 65535 drawables shared by every component is small in memory and
    // enormous in the file.
    budget.bytes += alignUp(value.length * field.stride, ARRAY_PADDING);
    if (budget.bytes > MAX_PAGES_BYTES) throw tooLarge();
    const out = new Array(value.length);
    // An index loop on purpose: it also visits the holes of a sparse array, which then fail the element check.
    for (let i = 0; i < value.length; i += 1) {
        out[i] = field.struct
            ? normaliseStruct(field.struct, value[i], `${path}[${i}]`, budget, i)
            : normaliseScalar(field.elementType, value[i], `${path}[${i}]`);
    }
    return out;
}

// A derived value that has to fit one byte in the file.
function derivedByte(value, path, source) {
    if (value > 255) throw specError(path, `cannot be derived: ${source} is ${value}, which does not fit a byte; give it explicitly`);
    return value;
}

// aAnchors as every game file has it: one item per anchor in ascending anchor
// order, props[k] = the texture count of that anchor's prop with propId k.
function deriveAnchors(props, path) {
    const countsByAnchor = new Map();
    for (const prop of props) {
        if (!countsByAnchor.has(prop.anchorId)) countsByAnchor.set(prop.anchorId, []);
        const counts = countsByAnchor.get(prop.anchorId);
        if (counts[prop.propId] !== undefined) {
            throw specError(path, `cannot be derived: two props have anchorId ${prop.anchorId} and propId ${prop.propId}`);
        }
        counts[prop.propId] = prop.texData.length;
    }
    return [...countsByAnchor.keys()].sort((a, b) => a - b).map(anchorId => {
        const counts = countsByAnchor.get(anchorId);
        for (let propId = 0; propId < counts.length; propId += 1) {
            if (counts[propId] === undefined) {
                throw specError(path, `cannot be derived: anchorId ${anchorId} has no prop with propId ${propId} (ids must run 0..n-1)`);
            }
        }
        return { props: counts, anchor: anchorId };
    });
}

// The derived fields a structure owns, filled once its own fields are normalised.
// (The root's are filled by normaliseDocument, which also knows the name.)
STRUCTS.get('CPVComponentData').derive = component => {
    if (component.numAvailTex !== undefined) return;
    let textures = 0;
    for (const drawable of component.aDrawblData3) textures += drawable.aTexData.length;
    // One byte, and Rockstar's own files let it wrap (286 textures are stored as 30).
    component.numAvailTex = textures & 0xFF;
};
STRUCTS.get('CPedPropTexData').derive = (texture, path, index) => {
    // Its position in texData, as in every game file (at most MAX_TEXTURES - 1, so it always fits the byte).
    if (texture.texId === undefined) texture.texId = index;
};
STRUCTS.get('CPedPropInfo').derive = (propInfo, path) => {
    const props = propInfo.aPropMetaData;
    const ordersProps = propInfo.aAnchors === undefined || props.some(prop => prop.propId === undefined);
    const seenOnAnchor = new Map();
    props.forEach((prop, index) => {
        const seen = seenOnAnchor.get(prop.anchorId) || 0;
        if (prop.propId === undefined) {
            prop.propId = derivedByte(seen, `${path}.aPropMetaData[${index}].propId`, 'the number of earlier props on that anchor');
        }
        seenOnAnchor.set(prop.anchorId, seen + 1);
    });
    // Every game file lists its props anchor by anchor, anchors ascending and
    // propId ascending inside an anchor. A doc that leaves ids or anchors to
    // this function gets its list in that order as well (props of one anchor
    // keep the order they were given in, which is what numbered them). A doc
    // that states both is the mirror of some file and is written as it stands.
    if (ordersProps) props.sort((a, b) => a.anchorId - b.anchorId || a.propId - b.propId);
    if (propInfo.numAvailProps === undefined) {
        propInfo.numAvailProps = derivedByte(props.length, `${path}.numAvailProps`, 'the number of props');
    }
    if (propInfo.aAnchors === undefined) propInfo.aAnchors = deriveAnchors(props, `${path}.aAnchors`);
};

// What an omitted field becomes (the derived ones stay undefined until their rule runs).
function omittedValue(field, path, budget) {
    if (field.required) throw specError(path, 'is required');
    if (field.derived) return undefined;
    if (field.kind === 'struct') return normaliseStruct(field.struct, {}, path, budget);
    if (field.kind === 'fixedArray') return new Array(field.count).fill(0);
    if (field.kind === 'array') return [];
    if (field.fallback !== undefined) return field.fallback;
    return field.type === DATA_TYPE.BOOL ? false : 0;
}

function normaliseStruct(struct, input, path, budget, index) {
    if (!isObject(input)) throw specError(path || 'doc', `must be an object (${struct.name}), got ${show(input)}`);
    for (const key of Object.keys(input)) {
        // A misspelt field would otherwise silently fall back to its default.
        if (!struct.fieldNames.has(key) && !(struct === ROOT && key === 'name')) {
            throw specError(`${path}${path ? '.' : ''}${showKey(key)}`, `is not a field of ${struct.name}`);
        }
    }
    const out = {};
    for (const field of struct.fields) {
        const fieldPath = path ? `${path}.${field.name}` : field.name;
        const value = own(input, field.name);
        if (isMissing(value)) out[field.name] = omittedValue(field, fieldPath, budget);
        else if (field.kind === 'struct') out[field.name] = normaliseStruct(field.struct, value, fieldPath, budget);
        else if (field.kind === 'scalar') out[field.name] = normaliseScalar(field.type, value, fieldPath);
        else if (field.kind === 'fixedArray') out[field.name] = normaliseFixedArray(field, value, fieldPath);
        else out[field.name] = normaliseArray(field, value, fieldPath, budget);
    }
    if (struct.derive) struct.derive(out, path, index);
    return out;
}

// The slots a collection has, when the doc does not say: the distinct slot
// numbers its compInfos name, in ascending order, one component each. (This
// reproduces availComp in 400 of the 462 game files; the other 62 carry
// components no compInfo names, and for those the rule refuses below instead
// of guessing.)
function deriveAvailComp(root) {
    const availComp = new Array(AVAIL_COMP_SLOTS).fill(SLOT_ABSENT);
    if (root.compInfos === undefined) {
        if (root.aComponentData3.length > 0) {
            throw specError('availComp', 'is required when aComponentData3 is not empty and compInfos is not given:'
                + ' nothing else says which slot each component is');
        }
        return availComp;
    }
    const slots = [...new Set(root.compInfos.map(info => info.pedXml_compIdx))].sort((a, b) => a - b);
    const beyond = slots.find(slot => slot >= AVAIL_COMP_SLOTS);
    if (beyond !== undefined) {
        throw specError('availComp', `cannot be derived: compInfos name slot ${beyond}, and a collection has the slots 0..${AVAIL_COMP_SLOTS - 1}`);
    }
    if (slots.length !== root.aComponentData3.length) {
        throw specError('availComp', `cannot be derived: compInfos name the slots [${slots.join(', ')}]`
            + ` but aComponentData3 has ${root.aComponentData3.length} item(s); give it explicitly`);
    }
    slots.forEach((slot, position) => { availComp[slot] = position; });
    return availComp;
}

// One CComponentInfo per drawable of every slot availComp lists, ascending by
// slot then drawable, with the game's neutral values ("none" audio, no flags).
// The index is a byte in the file, so 256 drawables can be numbered and are
// built (as CodeWalker builds them). The game hands out the count of a
// component's drawables as a byte as well, where 256 reads as 0: 255 is the
// most a collection can use.
function deriveCompInfos(root, budget) {
    const infos = [];
    root.availComp.forEach((position, slot) => {
        if (position === SLOT_ABSENT) return;
        const component = root.aComponentData3[position];
        if (!component) {
            throw specError('compInfos', `cannot be derived: availComp[${slot}] is ${position}`
                + ` but aComponentData3 has ${root.aComponentData3.length} item(s)`);
        }
        component.aDrawblData3.forEach((drawable, index) => {
            const indices = {
                pedXml_compIdx: slot,
                pedXml_drawblIdx: derivedByte(index, 'compInfos', `the drawable index in aComponentData3[${position}]`)
            };
            infos.push(normaliseStruct(STRUCTS.get('CComponentInfo'), indices, `compInfos[${infos.length}]`, budget));
        });
    });
    return infos;
}

// The resource's name string is stored one byte per character and ends at the
// first zero byte, so only characters 1..255 can be written back unchanged.
function normaliseName(value) {
    if (isMissing(value)) return '';
    if (typeof value !== 'string') throw specError('name', `must be a string, got ${show(value)}`);
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code < 1 || code > 255) throw specError('name', `has a character that does not fit one byte (position ${i})`);
    }
    return value;
}

function isAscii(text) {
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) > 0x7F) return false;
    return true;
}

function normaliseDocument(doc) {
    if (!isObject(doc)) throw specError('doc', `must be an object, got ${show(doc)}`);
    const budget = { bytes: 0 };
    const name = normaliseName(own(doc, 'name'));
    const root = normaliseStruct(ROOT, doc, '', budget);
    // Order matters: availComp may be read off explicit compInfos, and derived
    // compInfos are laid out from availComp.
    if (root.availComp === undefined) root.availComp = deriveAvailComp(root);
    if (root.compInfos === undefined) root.compInfos = deriveCompInfos(root, budget);
    if (root.dlcName === undefined) {
        // Every named game collection stores joaat(lower-cased name) here; the
        // unnamed base files store 0, which is also what an empty name hashes
        // to. All of those names are ASCII. Beyond ASCII the bytes stored for
        // the name (one per character) are no longer the bytes a hash of the
        // text is taken over, and no file shows which the game would want.
        if (!isAscii(name)) {
            throw specError('dlcName', 'cannot be derived from a name with characters outside ASCII; give it explicitly');
        }
        root.dlcName = joaat(name);
    }
    return { name, root };
}

function normaliseOptions(options) {
    if (isMissing(options)) return { layout: 'codewalker' };
    if (!isObject(options)) throw specError('options', `must be an object, got ${show(options)}`);
    for (const key of Object.keys(options)) {
        if (key !== 'layout') throw specError(`options.${showKey(key)}`, 'is not an option');
    }
    const given = own(options, 'layout');
    const layout = isMissing(given) ? 'codewalker' : given;
    if (layout !== 'codewalker' && layout !== 'ragelib') {
        throw specError('options.layout', `must be 'codewalker' or 'ragelib', got ${show(layout)}`);
    }
    return { layout };
}

// What a foreign exception said, for the error that replaces it. Looking at
// it runs the thrower's own code once more, and that can fail again.
function describeThrown(thrown) {
    try {
        return thrown instanceof Error ? show(String(thrown.message)) : show(thrown);
    } catch (error) {
        return 'something that cannot be described';
    }
}

// The builders promise one error code for anything wrong with what they are
// given. The checks above throw it themselves; what is left is the argument's
// own code failing while it is read (a getter or a Proxy trap that throws, a
// revoked Proxy), which would otherwise leave as whatever was thrown there.
function guarded(field, work) {
    try {
        return work();
    } catch (error) {
        if (error instanceof Error && error.code === 'bad_ymt_spec') throw error;
        throw specError(field, `could not be processed: ${describeThrown(error)}`);
    }
}

// ---------------------------------------------------------------------------
// 4. Content builder
// ---------------------------------------------------------------------------
// Turns a normalised doc into the logical content of the resource, placed the
// way CodeWalker's builder places it: the data blocks (every array header in
// them already final) and the lists of structures and enums the data uses.

function writeScalar(buffer, at, type, value) {
    if (type === DATA_TYPE.BOOL) buffer[at] = value ? 1 : 0;
    else if (type === DATA_TYPE.FLOAT) buffer.writeFloatLE(value, at);
    else if (SCALAR_BYTES[type] === 1) buffer[at] = value;
    else if (SCALAR_BYTES[type] === 2) buffer.writeUInt16LE(value, at);
    else buffer.writeUInt32LE(value, at);
}

function alignUp(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}

function buildContent(name, root) {
    const blocks = [];                  // { type, number, chunks, size } in creation order
    const lastBlockOfType = new Map();
    const structs = [];
    const enums = [];
    const addOnce = (list, item) => { if (!list.includes(item)) list.push(item); };

    // CodeWalker appends to the first block of the type that is still below
    // the limit. Blocks of one type fill up in creation order and a new one is
    // only opened once all earlier ones are full, so that is always the newest.
    function blockFor(type) {
        const last = lastBlockOfType.get(type);
        if (last && last.size < BLOCK_APPEND_LIMIT) return last;
        const block = { type, number: blocks.length + 1, chunks: [], size: 0 };
        blocks.push(block);
        lastBlockOfType.set(type, block);
        return block;
    }

    // Stores one array (all its elements, zero-padded as a whole) and returns
    // the packed pointer for its header. The pointer cannot overflow: the size
    // limit normalisation applied leaves room for far fewer than 4096 blocks
    // (one is only left behind once it holds 0x4000 bytes), and an array
    // always starts below that same 0x4000.
    function storeArray(type, bytes) {
        const block = blockFor(type);
        const offset = block.size;
        const padded = Buffer.alloc(alignUp(bytes.length, ARRAY_PADDING));
        bytes.copy(padded);
        block.chunks.push(padded);
        block.size += padded.length;
        return (block.number | (offset << ARRAY_BLOCK_BITS)) >>> 0;
    }

    function encodeStruct(struct, value) {
        const bytes = Buffer.alloc(struct.size);
        for (const field of struct.fields) {
            const fieldValue = value[field.name];
            if (field.kind === 'struct') {
                encodeStruct(field.struct, fieldValue).copy(bytes, field.offset);
            } else if (field.kind === 'fixedArray') {
                const width = SCALAR_BYTES[field.elementType];
                fieldValue.forEach((element, index) => writeScalar(bytes, field.offset + index * width, field.elementType, element));
            } else if (field.kind === 'array') {
                // An empty array stores nothing: its header stays 16 zero bytes and no block is opened for it.
                if (fieldValue.length === 0) continue;
                // The elements are encoded before the array itself is stored, so the arrays
                // they own land first: textures get a lower block number than drawables.
                // (An array that is not of structures is one of bytes.)
                const elements = field.struct
                    ? Buffer.concat(fieldValue.map(element => encodeStruct(field.struct, element)))
                    : Buffer.from(fieldValue);
                bytes.writeUInt32LE(storeArray(field.blockType, elements), field.offset + ARRAY_HEADER.POINTER);
                bytes.writeUInt16LE(fieldValue.length, field.offset + ARRAY_HEADER.COUNT);
                bytes.writeUInt16LE(fieldValue.length, field.offset + ARRAY_HEADER.CAPACITY);
            } else {
                // An enum is described in the file once a field that uses it has been written, whatever its value.
                if (field.enum) addOnce(enums, field.enum);
                writeScalar(bytes, field.offset, field.type, fieldValue);
            }
        }
        // A structure is listed when its first instance is complete, i.e. after everything it contains.
        addOnce(structs, struct);
        return bytes;
    }

    // The root's block is opened before anything else, so it is block 1, and
    // filled last, once every array header inside the root is known.
    const rootBlock = blockFor(ROOT.nameHash);
    const rootBytes = encodeStruct(ROOT, root);
    rootBlock.chunks.push(rootBytes);
    rootBlock.size += rootBytes.length;

    return {
        name,
        structs,
        enums,
        blocks: blocks.map(block => ({ type: block.type, data: Buffer.concat(block.chunks, block.size) }))
    };
}

// ---------------------------------------------------------------------------
// 5. Layouts
// ---------------------------------------------------------------------------
// A "part" is one contiguous run of bytes in the pages. The two layouts differ
// in which structures and enums they describe, in the order of the parts and
// in where each part starts; what a part holds is the same in both.

function makeParts(content, structs, enums, pagesInfoLength) {
    const part = length => ({ length, pos: 0 });
    const nameBytes = content.name ? Buffer.from(`${content.name}\0`, 'latin1') : null;
    return {
        structs,
        enums,
        blocks: content.blocks,
        nameBytes,
        header: part(META_HEADER_SIZE),
        pagesInfo: part(pagesInfoLength),
        structInfos: part(STRUCT_INFO_SIZE * structs.length),
        structEntries: structs.map(struct => part(struct.entryBytes.length)),
        enumInfos: enums.length ? part(ENUM_INFO_SIZE * enums.length) : null,
        enumEntries: enums.map(definition => part(ENUM_ENTRY_SIZE * definition.entries.length)),
        blockInfos: part(DATA_BLOCK_INFO_SIZE * content.blocks.length),
        blockData: content.blocks.map(block => part(block.data.length)),
        name: nameBytes ? part(nameBytes.length) : null
    };
}

// Fills the pages once every part has its position.
function writeParts(pages, parts, profile, systemPagesCount) {
    // A resource pointer is 64 bits wide; the high half is always zero, which the fresh buffer already is.
    const writePointer = (at, part) => pages.writeUInt32LE(part ? SYSTEM_BASE + part.pos : 0, at);

    pages.writeUInt32LE(profile.fileVft, META_HEADER.FILE_VFT);
    pages.writeUInt32LE(profile.fileUnknown, META_HEADER.FILE_UNKNOWN);
    writePointer(META_HEADER.PAGES_INFO_POINTER, parts.pagesInfo);
    pages.writeUInt32LE(META_MAGIC, META_HEADER.MAGIC);
    pages.writeUInt16LE(META_UNKNOWN_14, META_HEADER.UNKNOWN_14);
    pages.writeUInt32LE(1, META_HEADER.ROOT_BLOCK_INDEX);
    writePointer(META_HEADER.STRUCT_INFOS_POINTER, parts.structInfos);
    writePointer(META_HEADER.ENUM_INFOS_POINTER, parts.enumInfos);
    writePointer(META_HEADER.DATA_BLOCKS_POINTER, parts.blockInfos);
    writePointer(META_HEADER.NAME_POINTER, parts.name);
    pages.writeUInt16LE(parts.structs.length, META_HEADER.STRUCT_INFOS_COUNT);
    pages.writeUInt16LE(parts.enums.length, META_HEADER.ENUM_INFOS_COUNT);
    pages.writeUInt16LE(parts.blocks.length, META_HEADER.DATA_BLOCKS_COUNT);

    pages[parts.pagesInfo.pos + PAGES_INFO_PAGE_COUNT_OFFSET] = systemPagesCount;

    parts.structs.forEach((struct, index) => {
        const at = parts.structInfos.pos + STRUCT_INFO_SIZE * index;
        pages.writeUInt32LE(struct.nameHash, at + STRUCT_INFO.NAME);
        pages.writeUInt32LE(struct.key, at + STRUCT_INFO.KEY);
        pages.writeUInt32LE(struct.unk8, at + STRUCT_INFO.UNKNOWN_8);
        writePointer(at + STRUCT_INFO.ENTRIES_POINTER, parts.structEntries[index]);
        pages.writeUInt32LE(struct.size, at + STRUCT_INFO.SIZE);
        pages.writeUInt16LE(struct.entryCount, at + STRUCT_INFO.ENTRY_COUNT);
        struct.entryBytes.copy(pages, parts.structEntries[index].pos);
    });

    parts.enums.forEach((definition, index) => {
        const at = parts.enumInfos.pos + ENUM_INFO_SIZE * index;
        pages.writeUInt32LE(definition.nameHash, at + ENUM_INFO.NAME);
        pages.writeUInt32LE(definition.key, at + ENUM_INFO.KEY);
        writePointer(at + ENUM_INFO.ENTRIES_POINTER, parts.enumEntries[index]);
        pages.writeUInt32LE(definition.entries.length, at + ENUM_INFO.ENTRY_COUNT);
        definition.entries.forEach((entry, entryIndex) => {
            const entryAt = parts.enumEntries[index].pos + ENUM_ENTRY_SIZE * entryIndex;
            pages.writeUInt32LE(entry.nameHash, entryAt + ENUM_ENTRY.NAME);
            pages.writeInt32LE(entry.value, entryAt + ENUM_ENTRY.VALUE);
        });
    });

    parts.blocks.forEach((block, index) => {
        const at = parts.blockInfos.pos + DATA_BLOCK_INFO_SIZE * index;
        pages.writeUInt32LE(block.type, at + DATA_BLOCK_INFO.TYPE);
        pages.writeUInt32LE(block.data.length, at + DATA_BLOCK_INFO.LENGTH);
        writePointer(at + DATA_BLOCK_INFO.POINTER, parts.blockData[index]);
        block.data.copy(pages, parts.blockData[index].pos);
    });

    if (parts.name) parts.nameBytes.copy(pages, parts.name.pos);
}

// CodeWalker's packer for a meta: parts go down in order, each on a 16-byte
// boundary, never across a multiple of the page size. Two details decide byte
// equality: a part only "fits" with 16 bytes to spare (an exact fit moves to
// the next page), and a run that needs 128 pages or more is redone with the
// page size doubled.
function placeCodeWalker(order) {
    let largest = 0;
    for (const part of order) largest = Math.max(largest, part.length);
    let pageSize = BASE_PAGE_SIZE;
    while (pageSize < largest) pageSize *= 2;
    for (;;) {
        let pageCount = 0;
        let pos = 0;
        for (const part of order) {
            if (pageCount * pageSize - pos < part.length + CODEWALKER.slack) {
                pageCount += 1;
                pos = pageSize * (pageCount - 1);
            }
            part.pos = pos;
            pos = alignUp(pos + part.length, CODEWALKER.alignment);
        }
        if (pageCount < 128) return { pageSize, pageCount };
        pageSize *= 2;
    }
}

function layoutCodeWalker(content) {
    // Only what the data uses is described, in the order the content builder met it.
    const parts = makeParts(content, content.structs, content.enums, CODEWALKER.pagesInfoLength);
    const order = [
        parts.header, parts.pagesInfo,
        parts.structInfos, ...parts.structEntries,
        parts.enumInfos, ...parts.enumEntries,
        parts.blockInfos, ...parts.blockData,
        parts.name
    ].filter(Boolean);
    const { pageSize, pageCount } = placeCodeWalker(order);
    if (pageSize * pageCount > MAX_PAGES_BYTES) throw tooLarge();

    // CodeWalker spells "n pages of pageSize" with a base 16 times larger: the
    // low four bits of n go to the base/16, base/8, base/4 and base/2 flags and
    // the rest to the count of base-size pages. The flags therefore describe
    // fewer, larger pages than the packer used (three 0x2000 pages become one
    // 0x4000 and one 0x2000), and the pages info carries that smaller count.
    const shift = 31 - Math.clz32(pageSize / (BASE_PAGE_SIZE / 16));     // log2 of a power of two, in integer arithmetic
    const low = pageCount & 0xF;
    const high = pageCount >> 4;
    const systemFlags = (((low & 1) << 27) | ((low & 2) << 25) | ((low & 4) << 23) | ((low & 8) << 21) | (high << 17) | shift) >>> 0;
    const pagesInFlags = (low & 1) + ((low >> 1) & 1) + ((low >> 2) & 1) + (low >> 3) + high;

    const pages = Buffer.alloc(pageSize * pageCount);
    writeParts(pages, parts, CODEWALKER, pagesInFlags);
    return { pages, systemFlags };
}

// What the builder behind the 'ragelib' layout never writes, so that no file
// shows how it would arrange it. Returns the first such thing in a collection,
// or null.
function rageLibUnseen(name, root) {
    if (!name) return 'a collection without a name';
    if (root.aSelectionSets.length > 0) return 'a selection set';
    if (root.aComponentData3.length === 0 && root.propInfo.aPropMetaData.length === 0) return 'a collection with neither a component nor a prop';
    for (const component of root.aComponentData3) {
        if (component.aDrawblData3.length === 0) return 'a component without drawables';
        if (component.aDrawblData3.some(drawable => drawable.aTexData.length === 0)) return 'a drawable without textures';
    }
    if (root.propInfo.aPropMetaData.some(prop => prop.texData.length === 0)) return 'a prop without textures';
    if (root.propInfo.aAnchors.some(anchor => anchor.props.length === 0)) return 'an anchor without props';
    return null;
}

// Which structures a RageLib-built file describes, and in what order, depends
// on what the collection holds (a collection of props only does not describe
// textures, and lists the two prop structures the other way round). This walk
// gives the list of every file that builder has been seen to write: a
// structure is listed once everything inside one of its instances has been,
// together with the structures its own fields refer to, and the element
// structure of an array is listed even when the array is empty.
function rageLibStructs(root) {
    const structs = [];
    const addOnce = struct => { if (!structs.includes(struct)) structs.push(struct); };
    const list = struct => {
        addOnce(struct);
        for (const field of struct.fields) if (field.struct) addOnce(field.struct);
    };
    const visit = (struct, value) => {
        for (const field of struct.fields) {
            if (field.kind === 'struct') {
                visit(field.struct, value[field.name]);
            } else if (field.kind === 'array' && field.struct) {
                for (const element of value[field.name]) visit(field.struct, element);
                list(field.struct);
            }
        }
        list(struct);
    };
    visit(ROOT, root);
    return structs;
}

// The arrangement written by the builder of the two collections known to load
// in game, measured on those two files and on several hundred more made with
// that builder for the purpose. When one 0x2000 page is not enough it writes
// one larger page instead, and what it does there was not worked out; so
// anything that does not fit the page with room to spare is refused instead
// of guessed, and so is content it never writes at all.
function layoutRageLib(content, root) {
    const unseen = rageLibUnseen(content.name, root);
    if (unseen) {
        throw specError('options.layout', `'ragelib' cannot be used for ${unseen}:`
            + ` no file in that layout shows how it is arranged; use 'codewalker'`);
    }
    const enums = RAGELIB.enumOrder.map(name => ENUMS.get(name));
    const parts = makeParts(content, rageLibStructs(root), enums, RAGELIB.pagesInfoLength);
    const order = [
        parts.header, parts.name,
        parts.blockInfos, ...parts.blockData,
        parts.enumInfos, ...parts.enumEntries,
        parts.structInfos, ...parts.structEntries,
        parts.pagesInfo
    ];
    let pos = 0;
    for (const part of order) {
        if (BASE_PAGE_SIZE - pos < part.length + RAGELIB.gap) {
            throw specError('options.layout', `'ragelib' cannot hold this doc: it needs more than one ${BASE_PAGE_SIZE}-byte page,`
                + ` and that layout is only known for a single page; use 'codewalker'`);
        }
        part.pos = pos;
        pos = alignUp(pos + part.length + RAGELIB.gap, RAGELIB.alignment);
    }
    const pages = Buffer.alloc(BASE_PAGE_SIZE);
    writeParts(pages, parts, RAGELIB, 1);
    return { pages, systemFlags: RAGELIB.systemFlags };
}

// ---------------------------------------------------------------------------
// 6. RSC7 wrap
// ---------------------------------------------------------------------------

// 16-byte header, then the pages as one raw deflate stream (no zlib header, no
// checksum). The compressed bytes are not comparable between tools or zlib
// builds and do not need to be: a reader only ever sees the inflated pages.
function wrapRsc7(pages, systemFlags) {
    const header = Buffer.alloc(RSC7_HEADER_SIZE);
    header.writeUInt32LE(RSC7_MAGIC, RSC7_HEADER.MAGIC);
    header.writeUInt32LE(META_RESOURCE_VERSION, RSC7_HEADER.VERSION);
    header.writeUInt32LE(systemFlags, RSC7_HEADER.SYSTEM_FLAGS);
    header.writeUInt32LE(GRAPHICS_FLAGS, RSC7_HEADER.GRAPHICS_FLAGS);
    // Level 9: the pages are mostly zeros and a few kilobytes, so the best ratio costs nothing.
    return Buffer.concat([header, zlib.deflateRawSync(pages, { level: 9 })]);
}

function buildPedYmt(doc, options) {
    const { layout } = guarded('options', () => normaliseOptions(options));
    return guarded('doc', () => {
        const { name, root } = normaliseDocument(doc);
        const content = buildContent(name, root);
        const { pages, systemFlags } = layout === 'ragelib' ? layoutRageLib(content, root) : layoutCodeWalker(content);
        return wrapRsc7(pages, systemFlags);
    });
}

// ---------------------------------------------------------------------------
// 7. Reader
// ---------------------------------------------------------------------------

function fileError(problem) {
    const error = new Error(`ymt-writer: not a readable ped .ymt: ${problem}`);
    error.code = 'bad_ymt';
    return error;
}

// Bytes a page-flags word describes: a base size (0x2000 << the low nibble)
// and counts of pages of 16, 8, 4, 2, 1, 1/2, 1/4, 1/8 and 1/16 times it.
// Rockstar, CodeWalker and RageLib spell the same size differently; summing
// every field reads them all. (ydd-reader.js and hosted-ytd-baker.js decode
// the same word; it is repeated here because this module may only require
// node:zlib.)
function pageFlagsSize(flags) {
    const base = BASE_PAGE_SIZE * 2 ** (flags & 0xF);
    return base * (((flags >>> 4) & 0x1) * 16 + ((flags >>> 5) & 0x3) * 8 + ((flags >>> 7) & 0xF) * 4
        + ((flags >>> 11) & 0x3F) * 2 + ((flags >>> 17) & 0x7F)
        + ((flags >>> 24) & 0x1) / 2 + ((flags >>> 25) & 0x1) / 4 + ((flags >>> 26) & 0x1) / 8 + ((flags >>> 27) & 0x1) / 16);
}

// Checks the RSC7 header and returns the inflated system pages.
function openPages(file) {
    if (!ArrayBuffer.isView(file)) throw fileError('expected a Buffer holding the whole file');
    const raw = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
    if (raw.length < RSC7_HEADER_SIZE) throw fileError(`${raw.length} bytes is too short for an RSC7 header`);
    if (raw.readUInt32LE(RSC7_HEADER.MAGIC) !== RSC7_MAGIC) {
        throw fileError('it does not start with "RSC7" (the game also has PSO and XML .ymt files; only the RSC7 meta kind is read)');
    }
    const version = raw.readUInt32LE(RSC7_HEADER.VERSION);
    if (version !== META_RESOURCE_VERSION) throw fileError(`it is resource version ${version}; a meta resource is version ${META_RESOURCE_VERSION}`);
    const systemSize = pageFlagsSize(raw.readUInt32LE(RSC7_HEADER.SYSTEM_FLAGS));
    const graphicsSize = pageFlagsSize(raw.readUInt32LE(RSC7_HEADER.GRAPHICS_FLAGS));
    if (systemSize < META_HEADER_SIZE) throw fileError('its page flags leave no room for a meta header');
    if (systemSize + graphicsSize > MAX_PAGES_BYTES) {
        throw fileError(`its page flags claim ${systemSize + graphicsSize} bytes, more than any ped .ymt needs`);
    }
    let pages;
    try {
        // The limit stops a stream that inflates to more than the header declares before it is held in memory.
        pages = zlib.inflateRawSync(raw.subarray(RSC7_HEADER_SIZE), { maxOutputLength: systemSize + graphicsSize });
    } catch (error) {
        throw fileError(`its compressed pages cannot be inflated (${error.message})`);
    }
    if (pages.length < systemSize) throw fileError(`its pages inflate to ${pages.length} bytes but the header declares ${systemSize}`);
    return pages.subarray(0, systemSize);
}

function readScalar(pages, at, type) {
    if (type === DATA_TYPE.BOOL) return pages[at] !== 0;
    if (type === DATA_TYPE.FLOAT) return pages.readFloatLE(at);
    if (SCALAR_BYTES[type] === 1) return pages[at];
    if (SCALAR_BYTES[type] === 2) return pages.readUInt16LE(at);
    return pages.readUInt32LE(at);
}

// Returns the offset in the pages that the resource pointer at `pointerAt`
// leads to, after checking that `length` bytes from there lie inside them.
// Everything the header or an info record points at is reached through this.
function follow(pages, pointerAt, length, what) {
    const low = pages.readUInt32LE(pointerAt);
    if (pages.readUInt32LE(pointerAt + 4) !== 0 || low >>> 28 !== SYSTEM_BASE >>> 28) {
        throw fileError(`the pointer to ${what} (${hex32(low)}) does not lead into the system pages`);
    }
    const offset = low - SYSTEM_BASE;
    if (offset + length > pages.length) throw fileError(`${what} runs past the end of the pages`);
    return offset;
}

// The structure and enum descriptions are not needed to decode (the layout of
// every ped structure is fixed), but a file that describes one of them
// differently is some other format and must not be read as if it matched.
function checkDescriptions(pages) {
    const structCount = pages.readUInt16LE(META_HEADER.STRUCT_INFOS_COUNT);
    const structInfos = structCount ? follow(pages, META_HEADER.STRUCT_INFOS_POINTER, STRUCT_INFO_SIZE * structCount, 'the structure infos') : 0;
    for (let i = 0; i < structCount; i += 1) {
        const at = structInfos + STRUCT_INFO_SIZE * i;
        const entryCount = pages.readUInt16LE(at + STRUCT_INFO.ENTRY_COUNT);
        const entries = entryCount
            ? follow(pages, at + STRUCT_INFO.ENTRIES_POINTER, STRUCT_ENTRY_SIZE * entryCount, `the entries of structure info ${i}`)
            : 0;
        const known = STRUCT_BY_HASH.get(pages.readUInt32LE(at + STRUCT_INFO.NAME));
        if (known && (pages.readUInt32LE(at + STRUCT_INFO.SIZE) !== known.size || entryCount !== known.entryCount
            || pages.compare(known.entryBytes, 0, known.entryBytes.length, entries, entries + known.entryBytes.length) !== 0)) {
            throw fileError(`it describes ${known.name} with a layout this reader does not know`);
        }
    }
    const enumCount = pages.readUInt16LE(META_HEADER.ENUM_INFOS_COUNT);
    const enumInfos = enumCount ? follow(pages, META_HEADER.ENUM_INFOS_POINTER, ENUM_INFO_SIZE * enumCount, 'the enum infos') : 0;
    for (let i = 0; i < enumCount; i += 1) {
        const at = enumInfos + ENUM_INFO_SIZE * i;
        const entryCount = pages.readUInt32LE(at + ENUM_INFO.ENTRY_COUNT);
        if (entryCount) follow(pages, at + ENUM_INFO.ENTRIES_POINTER, ENUM_ENTRY_SIZE * entryCount, `the entries of enum info ${i}`);
    }
}

// The data block table: for each block its type, length and checked offset in the pages.
function readBlockTable(pages) {
    const blockCount = pages.readUInt16LE(META_HEADER.DATA_BLOCKS_COUNT);
    if (blockCount === 0) throw fileError('it has no data blocks');
    const blockInfos = follow(pages, META_HEADER.DATA_BLOCKS_POINTER, DATA_BLOCK_INFO_SIZE * blockCount, 'the data block table');
    const blocks = [];
    for (let i = 0; i < blockCount; i += 1) {
        const at = blockInfos + DATA_BLOCK_INFO_SIZE * i;
        const length = pages.readUInt32LE(at + DATA_BLOCK_INFO.LENGTH);
        blocks.push({
            type: pages.readUInt32LE(at + DATA_BLOCK_INFO.TYPE),
            length,
            offset: length ? follow(pages, at + DATA_BLOCK_INFO.POINTER, length, `data block ${i + 1}`) : 0
        });
    }
    return blocks;
}

function readName(pages) {
    if (pages.readUInt32LE(META_HEADER.NAME_POINTER) === 0 && pages.readUInt32LE(META_HEADER.NAME_POINTER + 4) === 0) return '';
    const start = follow(pages, META_HEADER.NAME_POINTER, 1, 'the name');
    const end = pages.indexOf(0, start);
    if (end === -1) throw fileError('its name string is not terminated');
    return pages.toString('latin1', start, end);
}

function decodeMeta(pages) {
    checkDescriptions(pages);
    const blocks = readBlockTable(pages);
    const rootBlock = blocks[pages.readUInt32LE(META_HEADER.ROOT_BLOCK_INDEX) - 1];
    if (!rootBlock || rootBlock.type !== ROOT.nameHash || rootBlock.length < ROOT.size) {
        throw fileError(`its root is not a ${ROOT.name} (is this a ped clothing .ymt?)`);
    }

    // The way from the root to what is being decoded, as field names and
    // element numbers. It only becomes text when something is wrong: a path
    // string for every record of a large file would cost more than decoding it.
    const trail = [];
    const where = () => trail.map(step => (typeof step === 'number' ? `[${step}]` : `.${step}`)).join('').slice(1);

    // Each byte of the pages may belong to one array only. Without this a small
    // file could point thousands of array headers at the same elements, level
    // under level, and decoding would take practically forever; with it the
    // total work is bounded by the size of the pages.
    const owned = new Uint8Array(pages.length);
    function claim(offset, length, what) {
        for (let i = offset; i < offset + length; i += 1) {
            if (owned[i]) throw fileError(`${what()} overlaps data that another array already uses`);
            owned[i] = 1;
        }
    }

    // Returns the offset in the pages of an array's first element, after
    // checking that the whole array lies inside a data block of the right type.
    function locateArray(headerAt, field, count) {
        const packed = pages.readUInt32LE(headerAt + ARRAY_HEADER.POINTER);
        const blockNumber = packed & ARRAY_BLOCK_MASK;
        const block = blocks[blockNumber - 1];
        const offset = packed >>> ARRAY_BLOCK_BITS;
        const length = count * field.stride;
        if (pages.readUInt32LE(headerAt + ARRAY_HEADER.POINTER + 4) !== 0) throw fileError(`${where()} has a malformed array pointer`);
        if (!block) throw fileError(`${where()} points at data block ${blockNumber}, which does not exist`);
        if (block.type !== field.blockType) throw fileError(`${where()} points at a data block of another type (${hex32(block.type)})`);
        if (offset + length > block.length) throw fileError(`${where()} (${count} entries) runs past the end of its data block`);
        claim(block.offset + offset, length, where);
        return block.offset + offset;
    }

    function decodeArray(field, headerAt) {
        // The count is the first of the header's two 16-bit numbers; an empty array has no meaningful pointer.
        const count = pages.readUInt16LE(headerAt + ARRAY_HEADER.COUNT);
        const list = new Array(count);
        if (count === 0) return list;
        const start = locateArray(headerAt, field, count);
        if (!field.struct) {
            for (let i = 0; i < count; i += 1) list[i] = readScalar(pages, start + i * field.stride, field.elementType);
            return list;
        }
        trail.push(0);
        for (let i = 0; i < count; i += 1) {
            trail[trail.length - 1] = i;
            list[i] = decodeStruct(field.struct, start + i * field.stride);
        }
        trail.pop();
        return list;
    }

    // Nesting ends where the schema ends (root -> component -> drawable ->
    // texture is the deepest chain), so the recursion needs no depth limit.
    function decodeStruct(struct, at) {
        const out = {};
        for (const field of struct.fields) {
            const fieldAt = at + field.offset;
            if (field.kind === 'scalar') {
                out[field.name] = readScalar(pages, fieldAt, field.type);
            } else if (field.kind === 'fixedArray') {
                const width = SCALAR_BYTES[field.elementType];
                const list = new Array(field.count);
                for (let i = 0; i < field.count; i += 1) list[i] = readScalar(pages, fieldAt + i * width, field.elementType);
                out[field.name] = list;
            } else {
                trail.push(field.name);
                out[field.name] = field.kind === 'struct' ? decodeStruct(field.struct, fieldAt) : decodeArray(field, fieldAt);
                trail.pop();
            }
        }
        return out;
    }

    const name = readName(pages);
    claim(rootBlock.offset, ROOT.size, () => 'the root structure');
    return Object.assign({ name }, decodeStruct(ROOT, rootBlock.offset));
}

function readPedYmt(file) {
    try {
        return decodeMeta(openPages(file));
    } catch (error) {
        if (error && error.code === 'bad_ymt') throw error;
        // Every read is range checked above, so this should be unreachable; it
        // is here so that the one promised error code holds even if a check is
        // ever missed, instead of a RangeError escaping to the caller.
        throw fileError(`decoding failed (${error && error.message})`);
    }
}

// ---------------------------------------------------------------------------
// 8. Single-item wrapper
// ---------------------------------------------------------------------------

// 28 characters is the longest collection name in the game's own data;
// staying inside it keeps generated names within lengths the game handles.
const DLC_NAME_PATTERN = /^[a-z0-9_]{1,28}$/;
// propMask, by bit value: 1 is always set, 16 says the mesh file ends in _r
// instead of _u, and 2, 4, 8, 64 (alpha, decal, cutout, palette) are the ones
// a source garment may carry over.
const PROP_MASK_LOW_BITS = 2 | 4 | 8 | 64;
const PROP_MASK_ALWAYS = 1;
const PROP_MASK_RACE_MESH = 16;

// Optional inputs that carry a source item's own values over: the field of
// the item's record each one fills, per kind of item. Where a kind is not
// listed the record has no such field, and the input is refused for that kind
// instead of dropped (a hat given a component's audio id would otherwise come
// out silently without it). propMaskLowBits, which fills part of a field, is
// handled where the propMask is put together.
const CARRIED_INPUTS = {
    audioId: { component: fieldOf('CComponentInfo.pedXml_audioID') },
    audioId2: { component: fieldOf('CComponentInfo.pedXml_audioID2') },
    expressionMods: { component: fieldOf('CComponentInfo.pedXml_expressionMods'), prop: fieldOf('CPedPropMetaData.expressionMods') },
    flags: { component: fieldOf('CComponentInfo.flags'), prop: fieldOf('CPedPropMetaData.flags') },
    renderFlags: { prop: fieldOf('CPedPropMetaData.renderFlags') },
    propFlags: { prop: fieldOf('CPedPropMetaData.propFlags') },
    stickyness: { prop: fieldOf('CPedPropMetaData.stickyness') }
};
const ITEM_KEYS = new Set(['gender', 'dlcName', 'kind', 'textures', 'componentId', 'meshSuffix', 'anchorId', 'propMaskLowBits',
    ...Object.keys(CARRIED_INPUTS)]);

// The carried inputs an item gives, checked, as fields of its record. What is
// omitted stays out, so that buildPedYmt's own default applies.
function carriedFields(item, kind) {
    const fields = {};
    for (const [key, targets] of Object.entries(CARRIED_INPUTS)) {
        const value = own(item, key);
        if (isMissing(value)) continue;
        const field = own(targets, kind);
        if (!field) throw specError(key, `does not apply to a ${kind}`);
        fields[field.name] = field.kind === 'fixedArray' ? normaliseFixedArray(field, value, key) : normaliseScalar(field.type, value, key);
    }
    return fields;
}

// One prop and nothing else. buildPedYmt gives it propId 0, numbers its
// textures in order and writes the one anchor entry that goes with it.
function propItemDocument(item, name, textures) {
    const anchorId = own(item, 'anchorId');
    if (!Number.isInteger(anchorId) || !Object.prototype.hasOwnProperty.call(PROP_ANCHORS, anchorId)) {
        throw specError('anchorId', `must be one of ${Object.keys(PROP_ANCHORS).join(', ')}, got ${show(anchorId)}`);
    }
    if (!isMissing(own(item, 'propMaskLowBits'))) throw specError('propMaskLowBits', 'does not apply to a prop');
    const prop = carriedFields(item, 'prop');
    prop.anchorId = anchorId;
    // What the entries of `textures` hold is ignored for a prop; only their number counts.
    prop.texData = Array.from(textures, () => ({}));
    return { name, propInfo: { aPropMetaData: [prop] } };
}

// One component with one drawable, mesh <slot>_000_<u|r>.ydd, texture i being
// letter a+i with the race suffix its texId names. buildPedYmt reads the slot
// off the compInfo and counts the textures.
function componentItemDocument(item, name, textures) {
    const componentId = own(item, 'componentId');
    if (!Number.isInteger(componentId) || componentId < 0 || componentId >= AVAIL_COMP_SLOTS) {
        throw specError('componentId', `must be an integer 0..${AVAIL_COMP_SLOTS - 1}, got ${show(componentId)}`);
    }
    const givenSuffix = own(item, 'meshSuffix');
    const meshSuffix = isMissing(givenSuffix) ? 'u' : givenSuffix;
    if (meshSuffix !== 'u' && meshSuffix !== 'r') throw specError('meshSuffix', `must be 'u' or 'r', got ${show(givenSuffix)}`);
    // Array.from, not map: it also visits the holes of a sparse array, which then fail the check.
    const aTexData = Array.from(textures, (texture, index) => {
        if (!isObject(texture)) throw specError(`textures[${index}]`, `must be an object, got ${show(texture)}`);
        const givenRace = own(texture, 'race');
        const race = isMissing(givenRace) ? 'uni' : givenRace;
        if (typeof race !== 'string' || !Object.prototype.hasOwnProperty.call(RACE_TEX_ID, race)) {
            throw specError(`textures[${index}].race`, `must be one of ${Object.keys(RACE_TEX_ID).join(', ')}, got ${show(givenRace)}`);
        }
        return { texId: RACE_TEX_ID[race] };
    });
    const givenBits = own(item, 'propMaskLowBits');
    const lowBits = isMissing(givenBits) ? 0 : givenBits;
    // The range test is not redundant: bitwise operators work on 32 bits, so
    // 4294967298 would pass the mask test as if it were 2.
    if (!Number.isInteger(lowBits) || lowBits < 0 || lowBits > PROP_MASK_LOW_BITS || (lowBits & ~PROP_MASK_LOW_BITS) !== 0) {
        throw specError('propMaskLowBits', `may only combine the bits 2, 4, 8 and 64, got ${show(givenBits)}`);
    }
    const info = carriedFields(item, 'component');
    info.pedXml_compIdx = componentId;
    info.pedXml_drawblIdx = 0;
    return {
        name,
        aComponentData3: [{
            aDrawblData3: [{
                propMask: PROP_MASK_ALWAYS | (meshSuffix === 'r' ? PROP_MASK_RACE_MESH : 0) | lowBits,
                aTexData
            }]
        }],
        compInfos: [info]
    };
}

// Checks an item description and returns the doc of a collection holding
// exactly that item. Only what the item decides is stated; every other value
// is buildPedYmt's default or derived by it, so the two cannot drift apart.
function itemDocument(item) {
    if (!isObject(item)) throw specError('item', `must be an object, got ${show(item)}`);
    for (const key of Object.keys(item)) {
        // As in a doc: a misspelt input would otherwise silently be left at its default.
        if (!ITEM_KEYS.has(key)) throw specError(showKey(key), 'is not an item input');
    }
    // Each input is read once, so the value that is checked is the value that is used.
    const gender = own(item, 'gender');
    const dlcName = own(item, 'dlcName');
    const kind = own(item, 'kind');
    const textures = own(item, 'textures');
    if (gender !== 'male' && gender !== 'female') throw specError('gender', `must be 'male' or 'female', got ${show(gender)}`);
    if (typeof dlcName !== 'string' || !DLC_NAME_PATTERN.test(dlcName)) {
        throw specError('dlcName', `must match ${DLC_NAME_PATTERN}, got ${show(dlcName)}`);
    }
    // Nothing in the file records the gender; it is asked for so that a female
    // garment cannot be given a male collection name by mistake.
    const prefix = gender === 'male' ? 'mp_m_' : 'mp_f_';
    if (!dlcName.startsWith(prefix)) throw specError('dlcName', `of a ${gender} item must start with '${prefix}', got ${show(dlcName)}`);
    if (kind !== 'component' && kind !== 'prop') throw specError('kind', `must be 'component' or 'prop', got ${show(kind)}`);
    if (!Array.isArray(textures) || textures.length < 1 || textures.length > MAX_TEXTURES) {
        throw specError('textures', `must be an array of 1..${MAX_TEXTURES} entries, got ${show(textures)}`);
    }
    return kind === 'prop' ? propItemDocument(item, dlcName, textures) : componentItemDocument(item, dlcName, textures);
}

function buildYmt(item, options) {
    return buildPedYmt(guarded('item', () => itemDocument(item)), options);
}

// ---------------------------------------------------------------------------
// 9. Exports
// ---------------------------------------------------------------------------

module.exports = {
    buildPedYmt,
    buildYmt,
    readPedYmt,
    joaat,
    RACE_TEX_ID,
    COMPONENT_PREFIXES,
    PROP_ANCHORS,
    MAX_TEXTURES
};
