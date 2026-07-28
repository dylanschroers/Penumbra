// Telling a path apart from a model/dataset *name*. Shared because both sides
// of the lab decide things on it: the UI on whether to upload a pick before a
// run, the server on whether a remote trainer could possibly open it.

/**
 * A value that names a file on some machine — an absolute path or `~` — versus
 * a HuggingFace id (`org/name`), which any trainer can fetch for itself.
 *
 * The leading `\\` case covers Windows UNC (`\\server\share`) and verbatim
 * (`\\?\F:\...`) paths. Missing those is not cosmetic: the path then skips the
 * upload and is sent to Studio as-is, which rejects it — the file lives on the
 * client, not the training host.
 */
export const looksLocalPath = (v: string): boolean =>
  /^(~|\/|\\\\|[A-Za-z]:[\\/])/.test(v);
