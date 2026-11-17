import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

/** Only the public descriptor is read; it never supplies a command to execute. */
export function managedAgentDir(launcher: string): string | undefined {
  if (!existsSync(launcher)) return undefined;
  const physical = realpathSync(launcher);
  const root = path.dirname(path.dirname(physical));
  if (path.basename(path.dirname(physical)) !== "bin") return undefined;
  const descriptor = path.join(root, "installation.json");
  if (!existsSync(descriptor) && !existsSync(path.join(root, "supervisor"))) return undefined;
  try {
    // Bound the read even for a descriptor that grows after opening.
    const fd = openSync(descriptor, "r");
    const buffer = Buffer.alloc(16385);
    let count = 0;
    try {
      let read: number;
      while (count < buffer.length && (read = readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += read;
    } finally { closeSync(fd); }
    if (count > 16384) throw new Error("descriptor too large");
    const data = JSON.parse(buffer.toString("utf8", 0, count));
    if (data.Schema !== "gentle-shell-user-install/v1" || data.Mode !== "separate" ||
        data.Destination !== root || typeof data.Agent !== "string" ||
        !path.isAbsolute(data.Agent) || data.Agent !== path.join(root, "agent") ||
        path.basename(physical) !== "gentle-shell") throw new Error("unsupported installation layout");
    return data.Agent;
  } catch (cause) {
    throw new Error(`Invalid installed supervisor installation descriptor: ${descriptor}`, { cause });
  }
}
