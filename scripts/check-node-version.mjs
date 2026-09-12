const [major, minor] = process.versions.node.split(".").map(Number);
const supported = major > 22 || (major === 22 && minor >= 12);

if (!supported) {
  console.error(
    `KCode tests require Node.js >= 22.12.0 because the state database and current build toolchain require it; found ${process.versions.node}.`,
  );
  process.exit(1);
}