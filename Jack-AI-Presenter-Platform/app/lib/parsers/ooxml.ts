export function resolvePackageTarget(
  sourcePartPath: string,
  target: string,
): string {
  const normalizedSource = sourcePartPath.replace(/\\/g, "/");
  const normalizedTarget = target.replace(/\\/g, "/");

  const result =
    normalizedTarget.startsWith("/")
      ? []
      : normalizedSource.split("/").slice(0, -1);

  for (const segment of normalizedTarget.split("/")) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      result.pop();
      continue;
    }

    result.push(segment);
  }

  return result.join("/");
}

export function relationshipsPathForPart(
  sourcePartPath: string,
): string {
  const normalized = sourcePartPath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");

  if (slash === -1) {
    return `_rels/${normalized}.rels`;
  }

  const dir = normalized.slice(0, slash);
  const file = normalized.slice(slash + 1);

  return `${dir}/_rels/${file}.rels`;
}
