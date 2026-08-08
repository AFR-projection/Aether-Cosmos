import { createCanvas } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";

const width = 1600;
const height = 1200;
const canvas = createCanvas(width, height);
const ctx = canvas.getContext("2d");

const background = ctx.createLinearGradient(0, 0, width, height);
background.addColorStop(0, "#090b12");
background.addColorStop(0.55, "#101625");
background.addColorStop(1, "#0a0c13");
ctx.fillStyle = background;
ctx.fillRect(0, 0, width, height);

function glow(x, y, radius, color, alpha) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `${color}${alpha}`);
  gradient.addColorStop(1, `${color}00`);
  ctx.fillStyle = gradient;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function ellipse(cx, cy, rx, ry, rotation, stroke, alpha, widthPx, dash = []) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);
  ctx.setLineDash(dash);
  ctx.strokeStyle = `${stroke}${alpha}`;
  ctx.lineWidth = widthPx;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function dot(x, y, radius, fill, alpha) {
  ctx.fillStyle = `${fill}${alpha}`;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

glow(1040, 550, 700, "#6c76ff", "28");
glow(380, 930, 460, "#86e2c7", "10");
glow(1350, 100, 380, "#a78bfa", "12");

ctx.save();
ctx.globalAlpha = 0.08;
ctx.strokeStyle = "#aab5ff";
ctx.lineWidth = 1;
for (let x = 80; x < width; x += 64) {
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}
for (let y = 56; y < height; y += 64) {
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();
}
ctx.restore();

const cx = 1010;
const cy = 582;
ellipse(cx, cy, 540, 215, -0.24, "#a9b2ff", "32", 2);
ellipse(cx, cy, 460, 340, 0.45, "#8d98ff", "22", 1);
ellipse(cx, cy, 330, 475, -0.76, "#99e4cc", "26", 1);
ellipse(cx, cy, 650, 505, 0.08, "#ffffff", "0b", 1, [3, 18]);
ellipse(cx, cy, 225, 225, 0, "#9aa5ff", "20", 1, [2, 12]);

ctx.save();
ctx.translate(cx, cy);
ctx.rotate(-0.24);
ctx.strokeStyle = "#bec5ff3a";
ctx.lineWidth = 1;
ctx.beginPath();
ctx.moveTo(-610, 0);
ctx.lineTo(610, 0);
ctx.stroke();
ctx.restore();

const nodes = [
  [496, 372, 7, "#a9b2ff", "d0"],
  [1434, 399, 5, "#8ee4c8", "bb"],
  [1266, 957, 6, "#a78bfa", "c4"],
  [671, 830, 4, "#e7eaff", "a0"],
  [1112, 153, 4, "#a9b2ff", "a0"],
  [154, 761, 3, "#8ee4c8", "80"],
  [1382, 780, 3, "#e7eaff", "80"],
];
for (const [x, y, radius, color, alpha] of nodes) {
  glow(x, y, 42, color, "20");
  dot(x, y, radius, color, alpha);
}

ctx.save();
ctx.strokeStyle = "#a9b2ff3c";
ctx.lineWidth = 1;
ctx.setLineDash([2, 12]);
for (const [x, y] of [[496, 372], [1434, 399], [1266, 957], [671, 830]]) {
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(x, y);
  ctx.stroke();
}
ctx.restore();

glow(cx, cy, 240, "#7884ff", "1c");
ctx.save();
ctx.shadowColor = "#7d8aff88";
ctx.shadowBlur = 28;
ctx.strokeStyle = "#c9ceffb8";
ctx.lineWidth = 2;
ctx.beginPath();
ctx.arc(cx, cy, 88, 0, Math.PI * 2);
ctx.stroke();
ctx.restore();
dot(cx, cy, 34, "#98a2ff", "38");
dot(cx, cy, 10, "#ecf0ff", "d8");

ctx.save();
ctx.font = "18px GeistMono";
ctx.fillStyle = "#d8ddff8c";
ctx.letterSpacing = "6px";
ctx.fillText("CONTROLLED ACCESS", 116, 1060);
ctx.font = "14px GeistMono";
ctx.fillStyle = "#b5c5ff70";
ctx.fillText("AFR / VAULT  ·  01", 116, 1098);
ctx.restore();

mkdirSync("public/auth", { recursive: true });
writeFileSync("public/auth/auth-constellation.png", canvas.toBuffer("image/png"));
