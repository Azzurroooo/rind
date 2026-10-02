// Shared HTML escaping for every renderer module that builds markup strings.

const entities: Readonly<Record<string, string>> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => entities[character] ?? character)
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/\n/g, "&#10;")
}
