// Which models a provider row still names that the provider no longer offers.
// Pure: the caller runs discovery and passes the entries in.
//
// Each kind is judged only against discovered entries OF THAT KIND. Zero such
// entries means discovery could not run (a source failed, or its shape is
// unverified), so we cannot judge and report nothing.
//
// Blank is always fine for sprite and image_edit (box default / base model).
// image is not checked here: its list is models_cache and stays as it is.
function missingModels(provider, entries) {
  const offered = (entries || []).filter((e) => e.kind === provider.modality).map((e) => e.id);
  if (offered.length === 0) return [];
  let wanted;
  if (provider.modality === 'text') wanted = [provider.model];
  else if (provider.modality === 'sprite' || provider.modality === 'image_edit') wanted = [provider.model];
  else if (provider.modality === 'audio') wanted = Object.values(provider.models_by_group || {});
  else return [];
  return [...new Set(wanted.filter((m) => typeof m === 'string' && m !== ''))]
    .filter((m) => !offered.includes(m));
}

module.exports = { missingModels };
