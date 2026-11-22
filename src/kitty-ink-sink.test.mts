/**
 * @file sections/sectium-device/kitty-ink-sink.test.mts
 * @description Unit and Web Streams roundtrip tests for the zero-dependency
 * Ink-like ANSI + Kitty Graphics TUI Sink (`kitty-ink-sink.mts`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createKittyInkWritableStream,
  encodeKittyGraphicsFrame,
  parseB8gElements,
  renderB8gElementToAnsi,
  renderRgbaToHalfBlockAnsi,
} from './kitty-ink-sink.mts';

const ESC = '\x1b';

describe('kitty-ink-sink', () => {
  it('renders <b8g-sectium-command> data-* attributes into a 24-bit ANSI box-drawing panel', () => {
    const html =
      '<b8g-sectium-command data-pipe="\\\\.\\pipe\\sectium-dev" data-channel="command" data-status="online"></b8g-sectium-command>';

    const parsed = parseB8gElements(html);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].tagName, 'b8g-sectium-command');
    assert.equal(parsed[0].dataset.pipe, '\\\\.\\pipe\\sectium-dev');
    assert.equal(parsed[0].dataset.channel, 'command');
    assert.equal(parsed[0].dataset.status, 'online');

    const ansi = renderB8gElementToAnsi(html);

    // Unicode box-drawing frame
    assert.match(ansi, /┌─/);
    assert.match(ansi, /┐/);
    assert.match(ansi, /│/);
    assert.match(ansi, /└/);
    assert.match(ansi, /┘/);

    // 24-bit ANSI true-color escapes
    assert.ok(ansi.includes(`${ESC}[38;2;`), 'expected 24-bit foreground ANSI sequence');
    assert.ok(ansi.includes(`${ESC}[0m`), 'expected ANSI reset sequence');

    // Content preserved accurately
    assert.ok(ansi.includes('b8g-sectium-command'));
    assert.ok(ansi.includes('\\\\.\\pipe\\sectium-dev'));
    assert.ok(ansi.includes('command'));
    assert.ok(ansi.includes('online'));
  });

  it('renders <b8g-sectium-display> and <b8g-sectium-devtools> with inner text cleanly', () => {
    const html = [
      '<b8g-sectium-display data-channel="display" data-resolution="1920x1080" />',
      '<b8g-sectium-devtools data-channel="command" data-client="antigravity">Cross-tab context synced</b8g-sectium-devtools>',
    ].join('\n');

    const ansi = renderB8gElementToAnsi(html, { width: 64 });
    assert.ok(ansi.includes('b8g-sectium-display'));
    assert.ok(ansi.includes('1920x1080'));
    assert.ok(ansi.includes('b8g-sectium-devtools'));
    assert.ok(ansi.includes('antigravity'));
    assert.ok(ansi.includes('Cross-tab context synced'));
    assert.ok(ansi.includes('├'), 'expected divider before inner text');
  });

  it('encodes multi-chunk (> 4096 B) Kitty Graphics APC frames with m=1 followed by m=0', () => {
    // 6000 bytes -> 8000 Base64 chars -> 2 chunks (4096 + 3904)
    const pngPayload = new Uint8Array(6000);
    pngPayload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    for (let i = 8; i < pngPayload.length; i++) {
      pngPayload[i] = i & 0xff;
    }

    const encoded = encodeKittyGraphicsFrame(pngPayload, { format: 'png' });
    const frames = encoded.split(`${ESC}\\`).filter((part) => part.length > 0);

    assert.equal(frames.length, 2, 'expected 2 APC chunks for 8000 Base64 chars');
    assert.ok(
      frames[0].startsWith(`${ESC}_Ga=T,f=100,m=1;`),
      `first chunk should start with a=T,f=100,m=1; got: ${frames[0].slice(0, 32)}`,
    );
    assert.ok(
      frames[1].startsWith(`${ESC}_Gm=0;`),
      `final chunk should start with m=0; got: ${frames[1].slice(0, 24)}`,
    );

    const chunk0Payload = frames[0].slice(frames[0].indexOf(';') + 1);
    const chunk1Payload = frames[1].slice(frames[1].indexOf(';') + 1);
    assert.equal(chunk0Payload.length, 4096);
    assert.equal(chunk1Payload.length, 3904);

    // Verify lossless Base64 roundtrip
    const decoded = Buffer.from(chunk0Payload + chunk1Payload, 'base64');
    assert.equal(decoded.byteLength, pngPayload.byteLength);
    assert.deepEqual(new Uint8Array(decoded), pngPayload);
  });

  it('encodes raw RGBA Kitty Graphics frames with f=32,s=w,v=h', () => {
    const rgba = new Uint8Array(2 * 2 * 4);
    rgba.fill(200);

    const encoded = encodeKittyGraphicsFrame(rgba, {
      format: 'rgba',
      width: 2,
      height: 2,
    });

    assert.ok(encoded.startsWith(`${ESC}_Ga=T,f=32,s=2,v=2,m=0;`));
    assert.ok(encoded.endsWith(`${ESC}\\`));
  });

  it('renders raw RGBA buffers into half-block (▀) 24-bit ANSI fallback cells', () => {
    // 2x2 RGBA:
    // Top row:    (255, 0, 0, 255) red,    (0, 255, 0, 255) green
    // Bottom row: (0, 0, 255, 255) blue,   (255, 255, 0, 255) yellow
    const rgba = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]);

    const ansi = renderRgbaToHalfBlockAnsi(rgba, 2, 2);

    assert.ok(ansi.includes('▀'), 'expected upper half block character');
    assert.ok(ansi.includes(`${ESC}[38;2;255;0;0m`), 'expected red foreground for top-left');
    assert.ok(ansi.includes(`${ESC}[48;2;0;0;255m`), 'expected blue background for bottom-left');
    assert.ok(ansi.includes(`${ESC}[38;2;0;255;0m`), 'expected green foreground for top-right');
    assert.ok(ansi.includes(`${ESC}[48;2;255;255;0m`), 'expected yellow background for bottom-right');
    assert.ok(ansi.endsWith(`${ESC}[0m`));
  });

  it('pipes ReadableStream -> WritableStream (createKittyInkWritableStream) for command and display frames', async () => {
    const outputs: string[] = [];

    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);

    const source = new ReadableStream<string | Uint8Array>({
      start(controller) {
        controller.enqueue(
          '<b8g-sectium-command data-pipe="\\\\.\\pipe\\sectium-dev" data-channel="command" />',
        );
        controller.enqueue(pngHeader);
        controller.close();
      },
    });

    const sink = createKittyInkWritableStream((chunk) => {
      outputs.push(chunk);
    });

    await source.pipeTo(sink);

    assert.equal(outputs.length, 2);
    // First chunk: ANSI box-drawing command panel
    assert.ok(outputs[0].includes('┌─'));
    assert.ok(outputs[0].includes('b8g-sectium-command'));
    assert.ok(outputs[0].includes('\\\\.\\pipe\\sectium-dev'));
    // Second chunk: Kitty Graphics APC frame
    assert.ok(outputs[1].startsWith(`${ESC}_Ga=T,f=100,m=0;`));
    assert.ok(outputs[1].endsWith(`${ESC}\\`));
  });

  it('supports half-block display fallback mode in createKittyInkWritableStream', async () => {
    const outputs: string[] = [];
    const rgba = new Uint8Array([
      10, 20, 30, 255,
      40, 50, 60, 255,
    ]);

    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(rgba);
        controller.close();
      },
    });

    const sink = createKittyInkWritableStream(
      (chunk) => {
        outputs.push(chunk);
      },
      {
        channel: 'display',
        graphicsMode: 'half-block',
        width: 1,
        height: 2,
      },
    );

    await source.pipeTo(sink);

    assert.equal(outputs.length, 1);
    assert.ok(outputs[0].includes(`${ESC}[38;2;10;20;30m`));
    assert.ok(outputs[0].includes(`${ESC}[48;2;40;50;60m`));
    assert.ok(outputs[0].includes('▀'));
  });
});
