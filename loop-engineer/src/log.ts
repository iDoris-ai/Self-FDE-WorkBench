/* eslint-disable no-console */
const ts = () => new Date().toISOString().slice(11, 19);

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export const log = {
  info: (msg: string) => console.log(`${c.dim(ts())} ${msg}`),
  step: (msg: string) => console.log(`${c.dim(ts())} ${c.cyan("▸")} ${c.bold(msg)}`),
  ok: (msg: string) => console.log(`${c.dim(ts())} ${c.green("✓")} ${msg}`),
  warn: (msg: string) => console.log(`${c.dim(ts())} ${c.yellow("!")} ${msg}`),
  err: (msg: string) => console.log(`${c.dim(ts())} ${c.red("✗")} ${msg}`),
  raw: (msg: string) => console.log(msg),
};

export { c as color };
