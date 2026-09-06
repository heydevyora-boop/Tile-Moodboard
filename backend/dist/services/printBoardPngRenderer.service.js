"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderPrintBoardPng = renderPrintBoardPng;
const canvas_1 = require("@napi-rs/canvas");
const printDimensions_1 = require("@utils/printDimensions");
const tileColorSwatches_1 = require("@utils/tileColorSwatches");
const AppError_1 = require("@utils/AppError");
const MAX_PNG_PIXELS = 120000000;
function pixelDimensions(widthValue, heightValue, unit, dpi) {
    const widthPx = Math.round((0, printDimensions_1.toInches)(widthValue, unit) * dpi);
    const heightPx = Math.round((0, printDimensions_1.toInches)(heightValue, unit) * dpi);
    if (widthPx * heightPx > MAX_PNG_PIXELS) {
        throw AppError_1.AppError.badRequest(`Requested PNG would be ${widthPx}x${heightPx}px (${((widthPx * heightPx) / 1000000).toFixed(0)} megapixels) — too large to render safely. ` +
            'Large-format panels typically only need 100-150 DPI for signage viewed at a distance; 300-600 DPI is meant for small close-up materials. Lower the DPI or reduce the physical dimensions, or use PDF export instead (vector, no pixel-count limit).');
    }
    return { widthPx, heightPx };
}
function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
    const words = text.split(/\s+/);
    let line = '';
    let cursorY = y;
    for (const word of words) {
        const trial = line ? `${line} ${word}` : word;
        if (ctx.measureText(trial).width > maxWidth && line) {
            ctx.fillText(line, x, cursorY);
            cursorY += lineHeight;
            line = word;
        }
        else {
            line = trial;
        }
    }
    if (line) {
        ctx.fillText(line, x, cursorY);
        cursorY += lineHeight;
    }
    return cursorY;
}
function drawSwatch(ctx, tile, x, y, w, h, scale) {
    ctx.fillStyle = (0, tileColorSwatches_1.colorForTileCss)(tile);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgb(33, 30, 23)';
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(x, y, w, h);
    const labelSize = Math.max(9 * scale, Math.min(13 * scale, w / 14));
    let cursorY = y + h + labelSize + 6 * scale;
    ctx.fillStyle = 'rgb(173, 131, 72)';
    ctx.font = `bold ${labelSize * 0.85}px sans-serif`;
    ctx.fillText(tile.role.toUpperCase(), x, cursorY);
    cursorY += labelSize + 2 * scale;
    ctx.fillStyle = 'rgb(33, 30, 23)';
    ctx.font = `${labelSize}px sans-serif`;
    cursorY = drawWrappedText(ctx, tile.name, x, cursorY, w, labelSize * 1.3);
    if (tile.brandName || tile.size) {
        const meta = [tile.brandName, tile.size].filter(Boolean).join(' \u00b7 ');
        ctx.fillStyle = 'rgb(120, 112, 95)';
        ctx.font = `${labelSize * 0.85}px sans-serif`;
        ctx.fillText(meta, x, cursorY);
    }
}
async function renderPrintBoardPng(input) {
    const { widthPx, heightPx } = pixelDimensions(input.widthValue, input.heightValue, input.unit, input.dpi);
    const scale = input.dpi / 150;
    const canvas = (0, canvas_1.createCanvas)(widthPx, heightPx);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(241, 236, 225)';
    ctx.fillRect(0, 0, widthPx, heightPx);
    const margin = Math.max(18 * scale, Math.min(widthPx, heightPx) * 0.04);
    const contentWidth = widthPx - margin * 2;
    let cursorY = margin;
    ctx.fillStyle = 'rgb(28, 25, 20)';
    ctx.font = `bold ${16 * scale}px sans-serif`;
    ctx.fillText('CASA DE AURUM', margin, cursorY + 16 * scale);
    ctx.fillStyle = 'rgb(120, 112, 95)';
    ctx.font = `${12 * scale}px sans-serif`;
    ctx.fillText(input.boardName, margin, cursorY + 34 * scale);
    cursorY += 54 * scale;
    const availableHeight = heightPx - cursorY - margin - 90 * scale;
    if (input.layout === 'HERO_IMAGE') {
        const base = input.tiles.find((t) => t.role === 'base');
        const others = input.tiles.filter((t) => t.role !== 'base');
        const heroHeight = availableHeight * 0.62;
        if (base)
            drawSwatch(ctx, base, margin, cursorY, contentWidth, heroHeight, scale);
        cursorY += heroHeight + 48 * scale;
        const stripW = (contentWidth - (others.length - 1) * 12 * scale) / Math.max(1, others.length);
        others.forEach((t, i) => drawSwatch(ctx, t, margin + i * (stripW + 12 * scale), cursorY, stripW, availableHeight * 0.28, scale));
    }
    else if (input.layout === 'SIDE_BY_SIDE') {
        const base = input.tiles.filter((t) => t.role === 'base');
        const rest = input.tiles.filter((t) => t.role !== 'base');
        const colW = (contentWidth - 20 * scale) / 2;
        base.forEach((t, i) => drawSwatch(ctx, t, margin, cursorY + i * (availableHeight / 2), colW, availableHeight * 0.85, scale));
        rest.forEach((t, i) => drawSwatch(ctx, t, margin + colW + 20 * scale, cursorY + i * (availableHeight / Math.max(1, rest.length)), colW, availableHeight / Math.max(1, rest.length) - 10 * scale, scale));
    }
    else if (input.layout === 'CASSETTE_STYLE') {
        const stripW = (contentWidth - (input.tiles.length - 1) * 10 * scale) / Math.max(1, input.tiles.length);
        input.tiles.forEach((t, i) => drawSwatch(ctx, t, margin + i * (stripW + 10 * scale), cursorY, stripW, availableHeight * 0.9, scale));
    }
    else {
        const perRow = Math.min(3, input.tiles.length) || 1;
        const cellW = (contentWidth - (perRow - 1) * 14 * scale) / perRow;
        const rowH = availableHeight / Math.ceil(input.tiles.length / perRow) - 46 * scale;
        input.tiles.forEach((t, i) => {
            const row = Math.floor(i / perRow);
            const col = i % perRow;
            drawSwatch(ctx, t, margin + col * (cellW + 14 * scale), cursorY + row * (rowH + 46 * scale), cellW, rowH, scale);
        });
    }
    const footerY = heightPx - margin - 68 * scale;
    ctx.strokeStyle = 'rgb(191, 181, 158)';
    ctx.lineWidth = Math.max(1, scale * 0.5);
    ctx.beginPath();
    ctx.moveTo(margin, footerY - 14 * scale);
    ctx.lineTo(widthPx - margin, footerY - 14 * scale);
    ctx.stroke();
    ctx.fillStyle = 'rgb(33, 30, 23)';
    ctx.font = `${9 * scale}px sans-serif`;
    let footerCursor = drawWrappedText(ctx, `Grout: ${input.groutRecommendation || 'Not specified'}`, margin, footerY, contentWidth, 12 * scale);
    ctx.fillStyle = 'rgb(120, 112, 95)';
    ctx.font = `${8 * scale}px sans-serif`;
    footerCursor = drawWrappedText(ctx, `Brief: ${input.clientBrief}`, margin, footerCursor, contentWidth, 11 * scale);
    const specs = `${input.format} \u00b7 ${input.widthValue}${input.unit.toLowerCase()} x ${input.heightValue}${input.unit.toLowerCase()} \u00b7 ${input.dpi} DPI \u00b7 Casa de Aurum Internal Tool`;
    ctx.fillStyle = 'rgb(153, 145, 128)';
    ctx.font = `${7 * scale}px sans-serif`;
    ctx.fillText(specs, margin, heightPx - margin);
    return canvas.toBuffer('image/png');
}
//# sourceMappingURL=printBoardPngRenderer.service.js.map