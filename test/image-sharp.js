'use strict';

// Functional test for the image resize path against the installed `sharp`.
// It reproduces resizeImage() from src/http/image/index.js verbatim, so a
// sharp bump that breaks the API/config used there fails here.
//
// Run with: node test/image-sharp.js

const assert = require('node:assert/strict');
const sharp = require('sharp');

const MAX_INPUT_PIXELS = 20 * 1000 * 1000;
const QUALITY = 95;

// --- exact copy of src/http/image/index.js:resizeImage -------------------
function resizeImage(buf, width, height) {
    return new Promise((rs, rj) => {
        sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
            .resize(width, height)
            .toFormat('png', { quality: QUALITY })
            .toBuffer((err, data) => {
                if (err) return rj(err)
                rs(data)
            })
    })
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log('  PASS:', name);
    } catch (err) {
        failed++;
        console.log('  FAIL:', name, '->', err.message);
    }
}

async function main() {
    console.log(`sharp ${sharp.versions.sharp} | libvips ${sharp.versions.vips} | node ${process.versions.node}\n`);

    const source = await sharp({
        create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 40, b: 90 } },
    }).png().toBuffer();

    const inputs = [
        ['png', source],
        ['jpeg', await sharp(source).jpeg().toBuffer()],
        ['webp', await sharp(source).webp().toBuffer()],
        ['gif', await sharp(source).gif().toBuffer()],
        ['tiff', await sharp(source).tiff().toBuffer()],
    ];

    for (const [fmt, buf] of inputs) {
        await test(`avatar resize ${fmt} -> png 64x64 (callback API)`, async () => {
            const out = await resizeImage(buf, 64, 64);
            assert.ok(out.subarray(0, 4).equals(PNG_MAGIC), 'output must be a PNG');
            const meta = await sharp(out).metadata();
            assert.equal(meta.format, 'png', 'format');
            assert.equal(meta.width, 64, 'width');
            assert.equal(meta.height, 64, 'height');
        });
    }

    await test('cover resize 2048x512 stays within bounds', async () => {
        const out = await resizeImage(source, 2048, 512);
        const meta = await sharp(out).metadata();
        assert.equal(meta.format, 'png');
        assert.ok(meta.width <= 2048 && meta.height <= 512, `${meta.width}x${meta.height}`);
    });

    await test('limitInputPixels guard rejects oversized input', async () => {
        const big = await sharp({
            create: { width: 5000, height: 5000, channels: 3, background: 'white' },
        }).png().toBuffer();
        await assert.rejects(() => resizeImage(big, 64, 64), /pixel limit|exceeds/i);
    });

    await test('garbage input rejects without crashing', async () => {
        await assert.rejects(() => resizeImage(Buffer.from('not an image'), 64, 64));
    });

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed) process.exit(1);
}

main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
});
