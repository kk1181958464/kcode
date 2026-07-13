import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "168_0_7ae3015cbc40.png");
const build = path.join(root, "build");
await mkdir(build, { recursive: true });

const metadata = await sharp(source).metadata();
const cropSize = Math.round(Math.min(metadata.width, metadata.height) * 0.527);
const icon = sharp(source).extract({
  left: Math.round(metadata.width * 0.238),
  top: Math.round(metadata.height * 0.17),
  width: cropSize,
  height: cropSize,
});
await icon.clone().resize(512, 512).png().toFile(path.join(build, "icon.png"));

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) => icon.clone().resize(size, size).png().toBuffer()),
);
await writeFile(path.join(build, "icon.ico"), await pngToIco(pngs));
