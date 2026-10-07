export async function importLegacyTeam({ client, root, confirm, share }) {
  const preview = await client.request("previewImport", { root });
  if (!confirm) return preview;
  return client.request("importTeam", { root, confirmation: preview.fingerprint, share });
}
