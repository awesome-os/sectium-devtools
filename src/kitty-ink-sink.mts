/**
 * @file sections/sectium-device/kitty-ink-sink.mts
 * @description Zero-dependency Ink-like ANSI + Kitty Graphics Protocol TUI Sink
 * over standard Web Streams for `<b8g-*>` HTML5 `data-*` elements and display
 * image frames in `sections/sectium-device/`.
 */

const ESC = '\x1b';
const ANSI_RESET = `${ESC}[0m`;
const ANSI_BOLD = `${ESC}[1m`;
const ANSI_DIM = `${ESC}[2m`;
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_KITTY_CHUNK_SIZE = 4096;

export type RgbColor = readonly [number, number, number];
export type BoxBorderStyle = 'single' | 'rounded' | 'double';
export type KittyPixelFormat = 'png' | 'rgba' | 'rgb';
export type KittyGraphicsAction = 'T' | 't' | 'p' | 'd' | 'q';
export type KittyInkChannelMode = 'auto' | 'command' | 'display';
export type KittyInkGraphicsMode = 'kitty' | 'half-block';

export interface ParsedB8gElement {
  tagName: string;
  attributes: Record<string, string>;
  dataset: Record<string, string>;
  textContent: string;
}

export interface RenderB8gAnsiOptions {
  /** Total outer box width in terminal columns (default: 72). */
  width?: number;
  /** Enable 24-bit ANSI true-color escape sequences (default: true). */
  color?: boolean;
  /** Override the 24-bit accent RGB color for borders and title. */
  accentRgb?: RgbColor;
  /** Unicode box-drawing border style (default: 'single'). */
  borderStyle?: BoxBorderStyle;
}

export interface KittyGraphicsEncodeOptions {
  /** Image payload format: 'png' (f=100), 'rgba' (f=32), or 'rgb' (f=24). */
  format?: KittyPixelFormat;
  /** Kitty Graphics Protocol action (default: 'T' transmit & display). */
  action?: KittyGraphicsAction;
  /** Pixel width (`s=`), required for raw 'rgba' / 'rgb' frames. */
  width?: number;
  /** Pixel height (`v=`), required for raw 'rgba' / 'rgb' frames. */
  height?: number;
  /** Optional Kitty image identifier (`i=`). */
  imageId?: number;
  /** Optional display width in terminal columns (`c=`). */
  columns?: number;
  /** Optional display height in terminal rows (`r=`). */
  rows?: number;
  /** Optional quiet mode (`q=0|1|2`). */
  quiet?: 0 | 1 | 2;
  /** Maximum Base64 payload bytes per APC chunk (default: 4096). */
  chunkSize?: number;
}

export interface HalfBlockAnsiOptions {
  /** Background RGB used for alpha compositing and odd-height bottom half (default: [0, 0, 0]). */
  backgroundRgb?: RgbColor;
}

export interface KittyInkWritableStreamOptions {
  /** Routing channel mode: 'auto' (default), 'command', or 'display'. */
  channel?: KittyInkChannelMode;
  /** Display frame rendering mode: 'kitty' (default) or 'half-block'. */
  graphicsMode?: KittyInkGraphicsMode;
  /** Options passed to `renderB8gElementToAnsi` for `<b8g-*>` chunks. */
  renderOptions?: RenderB8gAnsiOptions;
  /** Options passed to `encodeKittyGraphicsFrame` for display frames. */
  kittyOptions?: KittyGraphicsEncodeOptions;
  /** Options passed to `renderRgbaToHalfBlockAnsi` when `graphicsMode === 'half-block'`. */
  halfBlockOptions?: HalfBlockAnsiOptions;
  /** Convenience pixel width for raw RGBA/RGB `Uint8Array` frames. */
  width?: number;
  /** Convenience pixel height for raw RGBA/RGB `Uint8Array` frames. */
  height?: number;
  /** Append a trailing newline after rendered ANSI panels (default: true). */
  trailingNewline?: boolean;
}

interface BoxGlyphs {
  tl: string;
  tr: string;
  bl: string;
  br: string;
  h: string;
  v: string;
  ml: string;
  mr: string;
}

const BOX_GLYPHS: Record<BoxBorderStyle, BoxGlyphs> = {
  single: {
    tl: '┌',
    tr: '┐',
    bl: '└',
    br: '┘',
    h: '─',
    v: '│',
    ml: '├',
    mr: '┤',
  },
  rounded: {
    tl: '╭',
    tr: '╮',
    bl: '╰',
    br: '╯',
    h: '─',
    v: '│',
    ml: '├',
    mr: '┤',
  },
  double: {
    tl: '╔',
    tr: '╗',
    bl: '╚',
    br: '╝',
    h: '═',
    v: '║',
    ml: '╠',
    mr: '╣',
  },
};

const TAG_ACCENT_RGB: Record<string, RgbColor> = {
  'b8g-sectium-command': [56, 189, 248],
  'b8g-sectium-display': [192, 132, 252],
  'b8g-sectium-devtools': [251, 191, 36],
};

const DEFAULT_ACCENT_RGB: RgbColor = [52, 211, 153];
const KEY_RGB: RgbColor = [148, 163, 184];
const VALUE_RGB: RgbColor = [241, 245, 249];
const BADGE_RGB: RgbColor = [125, 211, 252];

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 255) return 255;
  return Math.round(n);
}

function fg24(rgb: RgbColor): string {
  return `${ESC}[38;2;${clampByte(rgb[0])};${clampByte(rgb[1])};${clampByte(rgb[2])}m`;
}

function bg24(rgb: RgbColor): string {
  return `${ESC}[48;2;${clampByte(rgb[0])};${clampByte(rgb[1])};${clampByte(rgb[2])}m`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(attrSource: string): {
  attributes: Record<string, string>;
  dataset: Record<string, string>;
} {
  const attributes: Record<string, string> = {};
  const dataset: Record<string, string> = {};
  const attrRe =
    /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrSource)) !== null) {
    const name = match[1].toLowerCase();
    const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
    const value = decodeHtmlEntities(rawValue);
    attributes[name] = value;
    if (name.startsWith('data-') && name.length > 5) {
      dataset[name.slice(5)] = value;
    }
  }

  return { attributes, dataset };
}

/**
 * Parses `<b8g-*>` HTML5 elements and their `data-*` attributes from a markup chunk.
 */
export function parseB8gElements(htmlChunk: string): ParsedB8gElement[] {
  const elements: ParsedB8gElement[] = [];
  const tagRe =
    /<(b8g-[a-z0-9-]+)((?:\s+[^<>]*?)?)\s*(?:\/>|>([\s\S]*?)<\/\1>|>(?![\s\S]*?<\/\1>))/gi;

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(htmlChunk)) !== null) {
    const tagName = match[1].toLowerCase();
    const attrSource = match[2] ?? '';
    const innerRaw = match[3] ?? '';
    const { attributes, dataset } = parseAttributes(attrSource);
    const textContent = decodeHtmlEntities(innerRaw.replace(/<[^>]+>/g, '')).trim();
    elements.push({
      tagName,
      attributes,
      dataset,
      textContent,
    });
  }

  return elements;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length <= maxWidth) {
      lines.push(rawLine);
      continue;
    }
    let remaining = rawLine;
    while (remaining.length > maxWidth) {
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    if (remaining.length > 0) {
      lines.push(remaining);
    }
  }
  return lines;
}

function renderPanel(
  element: ParsedB8gElement,
  options: RenderB8gAnsiOptions,
): string {
  const useColor = options.color !== false;
  const glyphs = BOX_GLYPHS[options.borderStyle ?? 'single'];
  const accent =
    options.accentRgb ?? TAG_ACCENT_RGB[element.tagName] ?? DEFAULT_ACCENT_RGB;

  const paint = (rgb: RgbColor, text: string, bold = false): string => {
    if (!useColor) return text;
    return `${bold ? ANSI_BOLD : ''}${fg24(rgb)}${text}${ANSI_RESET}`;
  };

  const dataEntries = Object.entries(element.dataset);
  const nonDataEntries = Object.entries(element.attributes).filter(
    ([k]) => !k.startsWith('data-'),
  );
  const allEntries = [...dataEntries, ...nonDataEntries];

  const channelBadge = element.dataset.channel
    ? `[${element.dataset.channel}]`
    : '';
  const headerLabel = channelBadge
    ? `${element.tagName} ${channelBadge}`
    : element.tagName;

  const maxKeyLen = allEntries.reduce((acc, [k]) => Math.max(acc, k.length), 0);
  const longestRowLen = allEntries.reduce(
    (acc, [, v]) => Math.max(acc, maxKeyLen + 3 + v.length),
    0,
  );
  const minContentWidth = Math.max(
    headerLabel.length + 2,
    longestRowLen,
    24,
  );
  const requestedOuter = options.width ?? Math.min(Math.max(minContentWidth + 4, 48), 96);
  const outerWidth = Math.max(requestedOuter, headerLabel.length + 6, 28);
  const innerWidth = outerWidth - 4; // `│ ` + content + ` │`

  const borderV = paint(accent, glyphs.v);
  const lines: string[] = [];

  // Top border: ┌─ <tagName> [channel] ────┐
  const titleVisibleLen = headerLabel.length;
  const rightRuleLen = Math.max(1, outerWidth - 4 - titleVisibleLen);
  const styledTitle = channelBadge
    ? `${paint(accent, element.tagName, true)} ${paint(BADGE_RGB, channelBadge)}`
    : paint(accent, element.tagName, true);

  lines.push(
    `${paint(accent, `${glyphs.tl}${glyphs.h} `)}${styledTitle}${paint(
      accent,
      ` ${glyphs.h.repeat(rightRuleLen)}${glyphs.tr}`,
    )}`,
  );

  const pushBoxRow = (styledContent: string): void => {
    const visibleLen = stripAnsi(styledContent).length;
    const pad = Math.max(0, innerWidth - visibleLen);
    lines.push(`${borderV} ${styledContent}${' '.repeat(pad)} ${borderV}`);
  };

  if (allEntries.length === 0 && element.textContent.length === 0) {
    const emptyMsg = useColor
      ? `${ANSI_DIM}(empty element)${ANSI_RESET}`
      : '(empty element)';
    pushBoxRow(emptyMsg);
  } else {
    for (const [key, value] of allEntries) {
      const paddedKey = key.padEnd(maxKeyLen, ' ');
      const prefixLen = maxKeyLen + 3; // `${key} : `
      const valueMaxWidth = Math.max(8, innerWidth - prefixLen);
      const wrappedValues = wrapText(value, valueMaxWidth);

      wrappedValues.forEach((segment, idx) => {
        if (idx === 0) {
          const styledKey = paint(KEY_RGB, paddedKey);
          const sep = useColor ? `${ANSI_DIM} : ${ANSI_RESET}` : ' : ';
          const styledVal = paint(VALUE_RGB, segment);
          pushBoxRow(`${styledKey}${sep}${styledVal}`);
        } else {
          const indent = ' '.repeat(prefixLen);
          pushBoxRow(`${indent}${paint(VALUE_RGB, segment)}`);
        }
      });
    }

    if (element.textContent.length > 0) {
      if (allEntries.length > 0) {
        lines.push(
          paint(accent, `${glyphs.ml}${glyphs.h.repeat(outerWidth - 2)}${glyphs.mr}`),
        );
      }
      for (const line of wrapText(element.textContent, innerWidth)) {
        pushBoxRow(paint(VALUE_RGB, line));
      }
    }
  }

  // Bottom border: └──────────────────────────┘
  lines.push(
    paint(accent, `${glyphs.bl}${glyphs.h.repeat(outerWidth - 2)}${glyphs.br}`),
  );

  return lines.join('\n');
}

/**
 * Ink-like ANSI `<b8g-*>` Renderer.
 * Parses `<b8g-sectium-command>`, `<b8g-sectium-display>`, `<b8g-sectium-devtools>`,
 * or any `<b8g-*>` HTML5 element and renders crisp Unicode box-drawing panels
 * with 24-bit ANSI true-color sequences (`\x1b[38;2;...m`).
 */
export function renderB8gElementToAnsi(
  htmlChunk: string,
  opts: RenderB8gAnsiOptions = {},
): string {
  const elements = parseB8gElements(htmlChunk);
  if (elements.length === 0) {
    const trimmed = htmlChunk.trim();
    if (trimmed.length === 0) {
      return '';
    }
    return renderPanel(
      {
        tagName: 'b8g-text',
        attributes: {},
        dataset: {},
        textContent: trimmed,
      },
      opts,
    );
  }
  return elements.map((el) => renderPanel(el, opts)).join('\n');
}

function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_MAGIC.byteLength) return false;
  for (let i = 0; i < PNG_MAGIC.byteLength; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      'base64',
    );
  }
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += step) {
    const slice = bytes.subarray(i, Math.min(i + step, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Kitty Graphics Protocol Encoder.
 * Encodes PNG (`f=100`), raw RGBA (`f=32,s=w,v=h`), or raw RGB (`f=24,s=w,v=h`)
 * buffers into standard 4096-byte chunked Kitty APC sequences
 * (`\x1b_Ga=T,f=...,m=1;...\x1b\\` ... `\x1b_Gm=0;...\x1b\\`).
 */
export function encodeKittyGraphicsFrame(
  bytes: Uint8Array,
  opts: KittyGraphicsEncodeOptions = {},
): string {
  const format: KittyPixelFormat =
    opts.format ??
    (isPngBytes(bytes)
      ? 'png'
      : opts.width !== undefined && opts.height !== undefined
        ? 'rgba'
        : 'png');

  const action: KittyGraphicsAction = opts.action ?? 'T';
  const chunkSize = opts.chunkSize ?? DEFAULT_KITTY_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 4 || chunkSize % 4 !== 0) {
    throw new RangeError(
      `Kitty chunkSize must be a positive multiple of 4 (got ${String(chunkSize)})`,
    );
  }

  const headerParts: string[] = [`a=${action}`];

  if (format === 'png') {
    headerParts.push('f=100');
  } else {
    const channels = format === 'rgba' ? 4 : 3;
    const width = opts.width;
    const height = opts.height;
    if (
      width === undefined ||
      height === undefined ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new RangeError(
        `Kitty raw ${format} frame requires positive integer width and height`,
      );
    }
    const expectedBytes = width * height * channels;
    if (bytes.byteLength < expectedBytes) {
      throw new RangeError(
        `Kitty raw ${format} buffer too small: expected at least ${expectedBytes} bytes, got ${bytes.byteLength}`,
      );
    }
    headerParts.push(`f=${channels * 8}`);
    headerParts.push(`s=${width}`);
    headerParts.push(`v=${height}`);
  }

  if (opts.imageId !== undefined) headerParts.push(`i=${opts.imageId}`);
  if (opts.columns !== undefined) headerParts.push(`c=${opts.columns}`);
  if (opts.rows !== undefined) headerParts.push(`r=${opts.rows}`);
  if (opts.quiet !== undefined) headerParts.push(`q=${opts.quiet}`);

  const base64 = encodeBase64(bytes);
  const baseHeader = headerParts.join(',');

  if (base64.length <= chunkSize) {
    return `${ESC}_G${baseHeader},m=0;${base64}${ESC}\\`;
  }

  const frames: string[] = [];
  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, base64.length);
    const isFirst = offset === 0;
    const isLast = end >= base64.length;
    const moreFlag = isLast ? 0 : 1;
    const payload = base64.slice(offset, end);

    if (isFirst) {
      frames.push(`${ESC}_G${baseHeader},m=${moreFlag};${payload}${ESC}\\`);
    } else {
      frames.push(`${ESC}_Gm=${moreFlag};${payload}${ESC}\\`);
    }
  }

  return frames.join('');
}

function compositePixel(
  rgba: Uint8Array,
  pixelIndex: number,
  bg: RgbColor,
): RgbColor {
  const offset = pixelIndex * 4;
  const r = rgba[offset] ?? 0;
  const g = rgba[offset + 1] ?? 0;
  const b = rgba[offset + 2] ?? 0;
  const a = rgba[offset + 3] ?? 255;

  if (a >= 255) {
    return [r, g, b];
  }
  if (a <= 0) {
    return bg;
  }
  const alpha = a / 255;
  const inv = 1 - alpha;
  return [
    Math.round(r * alpha + bg[0] * inv),
    Math.round(g * alpha + bg[1] * inv),
    Math.round(b * alpha + bg[2] * inv),
  ];
}

/**
 * ANSI Half-Block Fallback Renderer.
 * Renders raw RGBA buffers into `▀` (U+2580) 24-bit true-color ANSI cells
 * (top pixel as foreground `\x1b[38;2;...m`, bottom pixel as background `\x1b[48;2;...m`)
 * for plain terminals (PowerShell, SSH, serial `ttyS0`).
 */
export function renderRgbaToHalfBlockAnsi(
  rgba: Uint8Array,
  width: number,
  height: number,
  opts: HalfBlockAnsiOptions = {},
): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(
      `renderRgbaToHalfBlockAnsi requires positive integer width and height (got ${width}x${height})`,
    );
  }
  const requiredBytes = width * height * 4;
  if (rgba.byteLength < requiredBytes) {
    throw new RangeError(
      `RGBA buffer too small: expected at least ${requiredBytes} bytes for ${width}x${height}, got ${rgba.byteLength}`,
    );
  }

  const bg: RgbColor = opts.backgroundRgb ?? [0, 0, 0];
  const rows: string[] = [];

  for (let y = 0; y < height; y += 2) {
    let row = '';
    const hasBottom = y + 1 < height;
    for (let x = 0; x < width; x++) {
      const topRgb = compositePixel(rgba, y * width + x, bg);
      const bottomRgb = hasBottom
        ? compositePixel(rgba, (y + 1) * width + x, bg)
        : bg;
      row += `${fg24(topRgb)}${bg24(bottomRgb)}▀`;
    }
    row += ANSI_RESET;
    rows.push(row);
  }

  return rows.join('\n');
}

function looksLikeB8gMarkupBytes(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.byteLength && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {
    i++;
  }
  // `<b8g-` in ASCII: 0x3c 0x62 0x38 0x67 0x2d
  if (i + 5 > bytes.byteLength) return false;
  return (
    bytes[i] === 0x3c &&
    (bytes[i + 1] === 0x62 || bytes[i + 1] === 0x42) &&
    bytes[i + 2] === 0x38 &&
    (bytes[i + 3] === 0x67 || bytes[i + 3] === 0x47) &&
    bytes[i + 4] === 0x2d
  );
}

/**
 * Standard Web Streams `WritableStream<string | Uint8Array>` sink that seamlessly
 * routes `<b8g-*>` HTML5 `data-*` command chunks to the Ink-like ANSI renderer
 * and display image frames to Kitty Graphics APC or Half-Block ANSI output.
 */
export function createKittyInkWritableStream(
  onChunk: (rendered: string) => void | Promise<void>,
  opts: KittyInkWritableStreamOptions = {},
): WritableStream<string | Uint8Array> {
  const channel = opts.channel ?? 'auto';
  const graphicsMode = opts.graphicsMode ?? 'kitty';
  const trailingNewline = opts.trailingNewline !== false;
  const decoder = new TextDecoder('utf-8');

  return new WritableStream<string | Uint8Array>({
    async write(chunk: string | Uint8Array): Promise<void> {
      if (typeof chunk === 'string') {
        const rendered = renderB8gElementToAnsi(chunk, opts.renderOptions);
        if (rendered.length > 0) {
          await onChunk(trailingNewline ? `${rendered}\n` : rendered);
        }
        return;
      }

      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError(
          'createKittyInkWritableStream expects string or Uint8Array chunks',
        );
      }

      const routeAsCommand =
        channel === 'command' ||
        (channel === 'auto' && !isPngBytes(chunk) && looksLikeB8gMarkupBytes(chunk));

      if (routeAsCommand) {
        const text = decoder.decode(chunk);
        const rendered = renderB8gElementToAnsi(text, opts.renderOptions);
        if (rendered.length > 0) {
          await onChunk(trailingNewline ? `${rendered}\n` : rendered);
        }
        return;
      }

      const width = opts.width ?? opts.kittyOptions?.width;
      const height = opts.height ?? opts.kittyOptions?.height;

      if (graphicsMode === 'half-block') {
        if (width === undefined || height === undefined) {
          throw new RangeError(
            'half-block graphicsMode requires width and height in stream options',
          );
        }
        const rendered = renderRgbaToHalfBlockAnsi(
          chunk,
          width,
          height,
          opts.halfBlockOptions,
        );
        await onChunk(trailingNewline ? `${rendered}\n` : rendered);
        return;
      }

      const encoded = encodeKittyGraphicsFrame(chunk, {
        ...opts.kittyOptions,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      });
      await onChunk(encoded);
    },
  });
}
